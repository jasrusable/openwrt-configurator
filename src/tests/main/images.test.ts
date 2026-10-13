// Building images for a whole config: devices that would get the same image
// share one build, and the manifest's table says which image is whose.
import test from "ava";
import { createHash } from "crypto";
import { DeviceBuildPlan } from "../../getBuildPlan";
import { groupPlans, imageFilename, manifestTable } from "../../images";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const plan = (hostname: string, modelId: string, packages: string[] = ["luci"]): DeviceBuildPlan =>
  ({ deviceConfig: { hostname, modelId, tags: {} }, version: "25.12.5", packages, uciDefaults: "#!/bin/sh" }) as unknown as DeviceBuildPlan;

test("devices that would get the same image share one build, whatever their packages' order", (t) => {
  const groups = groupPlans([plan("ap-1", "zyxel,nwa50ax-pro", ["a", "b"]), plan("ap-2", "zyxel,nwa50ax-pro", ["b", "a"]), plan("gw", "friendlyarm,nanopi-r6s")], sha256);
  t.is(groups.size, 2);
  const [hash, aps] = [...groups].find(([, g]) => g.length === 2)!;
  t.deepEqual(aps.map((p) => p.deviceConfig.hostname), ["ap-1", "ap-2"]);
  t.is(imageFilename(aps[0], hash), `zyxel_nwa50ax-pro-25.12.5-${hash}.bin`);
});

test("the manifest's table: one aligned row per device, sorted by name", (t) => {
  const table = manifestTable([
    { filename: "b.bin", model_id: "m2", version: "25.12.5", sha256: "x", devices: [{ hostname: "zeta", tags: {} }] },
    { filename: "a.bin", model_id: "model-one", version: "25.12.5", sha256: "y", devices: [{ hostname: "ap", tags: {} }] },
  ]);
  t.deepEqual(table, [
    "hostname  model      version  image",
    "--------  ---------  -------  -----",
    "ap        model-one  25.12.5  a.bin",
    "zeta      m2         25.12.5  b.bin",
  ]);
  t.deepEqual(manifestTable([]), []);
});
