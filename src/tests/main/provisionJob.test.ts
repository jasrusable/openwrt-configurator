import test from "ava";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { nodePlatform } from "../../platforms/node";
import {
  jobPaths,
  provisionStatus,
  startProvision,
} from "../../server/provisionJob";

// The job runs this program again; here, a stand-in that prints and exits.
const withJob = async (
  script: string,
  run: (intentPath: string, files: typeof nodePlatform) => Promise<void>
) => {
  const dir = mkdtempSync(join(tmpdir(), "onc-job-"));
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, JSON.stringify({ schema: 1, site: { name: "A" } }));
  const files = { ...nodePlatform, selfCommand: () => ["sh", "-c", script, "onc"] };
  try {
    await run(intentPath, files);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const settle = async (intentPath: string, files: typeof nodePlatform) => {
  for (let i = 0; i < 100; i++) {
    const status = await provisionStatus({ intentPath, files });
    if (status.state !== "running") return status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the job never finished");
};

test.serial("a successful run makes the provisioned snapshot live", async (t) => {
  await withJob('sleep 0.3; echo "ran $1 $2"', async (intentPath, files) => {
    t.is((await provisionStatus({ intentPath, files })).state, "idle");
    t.true((await startProvision({ intentPath, files, now: () => 42 })).started);
    t.is((await provisionStatus({ intentPath, files })).state, "running");
    // An edit during the run is not what gets provisioned.
    writeFileSync(intentPath, JSON.stringify({ schema: 1, site: { name: "B" } }));

    const status = await settle(intentPath, files);
    t.is(status.state, "succeeded");
    t.is(status.startedAt, 42);
    t.regex(status.log, /ran provision .*provisioning\.json/);
    t.is(
      JSON.parse(readFileSync(jobPaths(intentPath).live, "utf8")).site.name,
      "A"
    );
    t.is(status.live, "differs", "the draft moved on during the run");
  });
});

test.serial("a run applied everywhere whose later step failed is live, and says so", async (t) => {
  await withJob("echo hook failed >&2; exit 3", async (intentPath, files) => {
    await startProvision({ intentPath, files, now: () => 1 });
    const status = await settle(intentPath, files);
    t.is(status.state, "applied-with-problems", JSON.stringify(status));
    t.is(status.live, "matches");
  });
});

test.serial("a failed run leaves what was live", async (t) => {
  await withJob("echo boom >&2; exit 4", async (intentPath, files) => {
    await startProvision({ intentPath, files, now: () => 1 });
    const status = await settle(intentPath, files);
    t.is(status.state, "failed", JSON.stringify(status));
    t.is(status.exitCode, 4);
    t.regex(status.log, /boom/);
    t.is(status.live, "none");
  });
});

test.serial("two requests at the same moment start one run", async (t) => {
  await withJob("sleep 0.5", async (intentPath, files) => {
    const both = await Promise.all([1, 2, 3].map((n) => startProvision({ intentPath, files, now: () => n })));
    t.is(both.filter((r) => r.started).length, 1);
    t.is((await settle(intentPath, files)).state, "succeeded");
    t.true((await startProvision({ intentPath, files, now: () => 4 })).started, "the lock is given back");
    await settle(intentPath, files);
  });
});

test.serial("only one run at a time", async (t) => {
  await withJob("sleep 0.5", async (intentPath, files) => {
    t.true((await startProvision({ intentPath, files, now: () => 1 })).started);
    const second = await startProvision({ intentPath, files, now: () => 2 });
    t.false(second.started);
    await settle(intentPath, files);
  });
});

test.serial("a lock left by a job that died is taken over: a dead pid, a pid from another boot", async (t) => {
  await withJob("echo ran", async (intentPath, files) => {
    const paths = jobPaths(intentPath);
    const left = (pidLine: string) => {
      rmSync(paths.lock, { recursive: true, force: true });
      require("fs").mkdirSync(paths.dir, { recursive: true });
      require("fs").mkdirSync(paths.lock);
      writeFileSync(paths.started, "1");
      writeFileSync(paths.pid, pidLine);
      rmSync(paths.exit, { force: true });
    };
    // A pid that is not running (written in the same second as the lock).
    left("999999 whatever-boot\n");
    t.is((await provisionStatus({ intentPath, files })).state, "interrupted");
    t.true((await startProvision({ intentPath, files, now: () => 2 })).started);
    t.is((await settle(intentPath, files)).state, "succeeded");
    // This very process's pid, but from another boot: after a reboot it may be anyone's.
    left(`${process.pid} another-boot\n`);
    t.is((await provisionStatus({ intentPath, files })).state, "interrupted");
    t.true((await startProvision({ intentPath, files, now: () => 3 })).started);
    t.is((await settle(intentPath, files)).state, "succeeded");
  });
});

test.serial("a lock with no pid yet is a job starting, for a minute; then it is stale", async (t) => {
  await withJob("echo ran", async (intentPath, files) => {
    const paths = jobPaths(intentPath);
    require("fs").mkdirSync(paths.lock, { recursive: true });
    writeFileSync(paths.started, "1");
    t.is((await provisionStatus({ intentPath, files })).state, "running");
    t.false((await startProvision({ intentPath, files, now: () => 2 })).started);
    const old = new Date(Date.now() - 5 * 60_000);
    require("fs").utimesSync(paths.lock, old, old);
    t.is((await provisionStatus({ intentPath, files })).state, "interrupted");
    t.true((await startProvision({ intentPath, files, now: () => 3 })).started);
    t.is((await settle(intentPath, files)).state, "succeeded");
  });
});
