// The firmware download path, against a fake HTTP: which image is picked, that
// transient answers are retried and others not, and that a file whose size or
// sha256 is not what the build said is never kept.
import test from "ava";
import { BuildResult, downloadImage, pickSysupgradeImage, requestBuild } from "../../buildImage";
import { HttpResponse } from "../../platform";

const image = (name: string, type: string) => ({ name, type, sha256: "s", size: 1 });
const result = (...images: BuildResult["images"]): BuildResult => ({ bin_dir: "b", images });

test("the squashfs sysupgrade image is picked over the others", (t) => {
  const picked = pickSysupgradeImage(
    result(image("x-factory.bin", "factory"), image("x-ext4-sysupgrade.bin", "sysupgrade"), image("x-squashfs-sysupgrade.bin", "sysupgrade"))
  );
  t.is(picked.name, "x-squashfs-sysupgrade.bin");
});

test("a build with no sysupgrade image is refused, naming what it has", (t) => {
  t.throws(() => pickSysupgradeImage(result(image("x-factory.bin", "factory"))), { message: /factory/ });
});

const answers = (statuses: number[]) => {
  const calls: number[] = [];
  const platform = {
    sleep: async () => {},
    http: {
      request: async (): Promise<HttpResponse> => {
        const status = statuses[calls.length];
        calls.push(status);
        return { status, headers: {}, body: JSON.stringify(status === 200 ? { request_hash: "h" } : { detail: "x" }) };
      },
      download: async () => ({ bytes: 0 }),
    },
  };
  return { platform, calls };
};

test("a transient answer from the build server is retried", async (t) => {
  const { platform, calls } = answers([503, 502, 200]);
  const warn = console.warn;
  console.warn = () => {};
  t.teardown(() => (console.warn = warn));
  t.deepEqual(await requestBuild({ req: {} as never, platform }), { requestHash: "h" });
  t.is(calls.length, 3);
});

test("a refusal is not retried", async (t) => {
  const { platform, calls } = answers([400, 200]);
  await t.throwsAsync(requestBuild({ req: {} as never, platform }));
  t.is(calls.length, 1);
});

const downloading = ({ bytes, sha256 }: { bytes: number; sha256: string }) => {
  const removed: string[] = [];
  const platform = {
    mkdirp: () => {},
    http: { request: async () => ({}) as HttpResponse, download: async () => ({ bytes }) },
    sha256File: async () => sha256,
    readFileHead: () => new Uint8Array([0x68, 0x73, 0x71, 0x73]),
    removeFile: (path: string) => void removed.push(path),
  };
  const download = () =>
    downloadImage({ binDir: "b", name: "x.bin", outPath: "/out/x.bin", expectedSha256: "good", expectedSize: 4, platform });
  return { download, removed };
};

test("a download whose sha256 differs from the build's is removed", async (t) => {
  const { download, removed } = downloading({ bytes: 4, sha256: "bad" });
  await t.throwsAsync(download(), { message: /sha256 mismatch/ });
  t.deepEqual(removed, ["/out/x.bin"]);
});

test("a short download is removed", async (t) => {
  const { download, removed } = downloading({ bytes: 3, sha256: "good" });
  await t.throwsAsync(download(), { message: /size mismatch/ });
  t.deepEqual(removed, ["/out/x.bin"]);
});

test("a download that matches is kept, its format named", async (t) => {
  const { download, removed } = downloading({ bytes: 4, sha256: "good" });
  t.like(await download(), { sha256: "good", magic: "squashfs" });
  t.deepEqual(removed, []);
});
