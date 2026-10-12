// Provisioning started from the UI, as a background job. A provision takes
// minutes and a CGI request lives for one response, so the job is this
// program run again (`provision <snapshot>`) as a detached child, with its
// output in a log file the UI polls. All of its state is files beside the
// intent file, so a CGI process and the Node server see the same job.
//
// The job provisions a snapshot of the intent taken when it starts, so edits
// made meanwhile are not half-applied. Only a successful run promotes that
// snapshot to `live.json`: the UI compares the draft with it.
import { Platform } from "../platform";
import { appliedWithProblemsExit } from "../devicePhases";
import { shellQuote } from "../shell";

type Files = Pick<
  Platform,
  "readTextFile" | "run" | "selfCommand"
>;

export type ProvisionState =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  /** Applied everywhere, but a step after it (a hook) failed. */
  | "applied-with-problems"
  /** The job stopped without recording an exit: killed, or the host restarted. */
  | "interrupted";

export type ProvisionStatus = {
  state: ProvisionState;
  startedAt?: number;
  exitCode?: number;
  /** The job's output so far, newest last. */
  log: string;
  /** Whether the saved draft is what was last provisioned. */
  live: "none" | "matches" | "differs";
};

/** Where a job's files live: a directory beside the intent file. */
export const jobPaths = (intentPath: string) => {
  const dir = `${intentPath}.state`;
  return {
    dir,
    snapshot: `${dir}/provisioning.json`,
    live: `${dir}/live.json`,
    log: `${dir}/provision.log`,
    pid: `${dir}/provision.pid`,
    exit: `${dir}/provision.exit`,
    started: `${dir}/provision.started`,
    /** Held from start to exit (mkdir is atomic), so two requests cannot both start a job. */
    lock: `${dir}/provision.lock`,
  };
};

const read = (files: Files, path: string) => {
  try {
    return files.readTextFile(path);
  } catch {
    return undefined;
  }
};

/** Key order does not matter: the file is rewritten on every save. */
const canonical = (json: string) => {
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sort((value as Record<string, unknown>)[key])])
        )
      : value;
  return JSON.stringify(sort(JSON.parse(json)));
};

const isRunning = async (files: Files, pid: string | undefined) =>
  !!pid && (await files.run(["kill", "-0", pid.trim()])).code === 0;

export const provisionStatus = async ({
  intentPath,
  files,
}: {
  intentPath: string;
  files: Files;
}): Promise<ProvisionStatus> => {
  const paths = jobPaths(intentPath);
  const started = read(files, paths.started);
  // Alive first, then the exit file: the job writes its exit before it ends,
  // so one seen dead has either recorded its exit or was really interrupted.
  // The other order calls a job that ends between the two reads interrupted.
  // Or just starting: the lock taken, its pid not yet written.
  const starting = async () => (await files.run(["sh", "-c", `[ -d ${shellQuote(paths.lock)} ] && ! [ ${shellQuote(paths.pid)} -nt ${shellQuote(paths.lock)} ]`])).code === 0;
  const running = !!started && ((await isRunning(files, read(files, paths.pid))) || (await starting()));
  const exit = running ? undefined : read(files, paths.exit);
  const draft = read(files, intentPath);
  const live = read(files, paths.live);
  const exitCode = exit === undefined ? undefined : Number(exit.trim());
  return {
    state: !started
      ? "idle"
      : running
      ? "running"
      : exitCode === undefined
      ? "interrupted"
      : exitCode === 0
      ? "succeeded"
      : exitCode === appliedWithProblemsExit
      ? "applied-with-problems"
      : "failed",
    startedAt: started ? Number(started) : undefined,
    exitCode,
    log: (read(files, paths.log) ?? "").split("\n").slice(-400).join("\n"),
    live: !live
      ? "none"
      : draft && canonical(draft) === canonical(live)
      ? "matches"
      : "differs",
  };
};

const alreadyRunning = 75;

/** Start a provision of the saved intent, unless one is already running. */
export const startProvision = async ({
  intentPath,
  files,
  now,
}: {
  intentPath: string;
  files: Files;
  now: () => number;
}) => {
  const status = await provisionStatus({ intentPath, files });
  if (status.state === "running") {
    return { started: false as const, reason: "Settings are already being applied." };
  }
  const paths = jobPaths(intentPath);
  const q = shellQuote;
  // It refreshes the device facts as it reads the devices (deviceFacts.ts).
  const command = [...files.selfCommand(), "provision", paths.snapshot, "--facts-for", intentPath]
    .map(q)
    .join(" ");
  // The subshell is backgrounded with every stream redirected, so `sh` returns
  // at once and the job outlives this request. The exit and pid files are
  // renamed into place: read half-written, an empty exit file is "exit 0". A non-interactive shell's
  // background jobs ignore SIGINT, so it also survives a Ctrl-C of the server.
  // The lock is taken first and given back by the job as it ends. One left
  // by a job that was killed is taken over: its pid, written after the lock,
  // is no longer running.
  const script = [
    `mkdir -p ${q(paths.dir)} && chmod 700 ${q(paths.dir)}`,
    `mkdir ${q(paths.lock)} 2>/dev/null || { [ ${q(paths.pid)} -nt ${q(paths.lock)} ] && ! kill -0 "$(cat ${q(paths.pid)})" 2>/dev/null && touch ${q(paths.lock)}; } || exit ${alreadyRunning}`,
    `echo ${now()} > ${q(paths.started)}`,
    `rm -f ${q(paths.exit)} ${q(paths.log)}`,
    `cp ${q(intentPath)} ${q(paths.snapshot)}`,
    `( ${command} > ${q(paths.log)} 2>&1; code=$?;` +
      ` if [ $code -eq 0 ] || [ $code -eq ${appliedWithProblemsExit} ]; then mv ${q(paths.snapshot)} ${q(paths.live)}; fi;` +
      ` echo $code > ${q(paths.exit)}.tmp; mv ${q(paths.exit)}.tmp ${q(paths.exit)}; rmdir ${q(paths.lock)}` +
      ` ) < /dev/null > /dev/null 2>&1 &`,
    `echo $! > ${q(paths.pid)}.tmp; mv ${q(paths.pid)}.tmp ${q(paths.pid)}`,
  ].join("\n");
  const result = await files.run(["sh", "-c", script]);
  if (result.code === alreadyRunning) return { started: false as const, reason: "Settings are already being applied." };
  if (result.code !== 0) {
    return {
      started: false as const,
      reason: `Could not start the provision: ${result.stderr.trim()}`,
    };
  }
  return { started: true as const };
};
