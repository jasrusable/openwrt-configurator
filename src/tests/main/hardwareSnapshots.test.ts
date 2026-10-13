import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { deviceSchemaSchema } from "../../deviceSchema";
import { getOpenWrtConfig } from "../../engine/getOpenWrtConfig";
import { getUciCommands } from "../../engine/getUciCommands";
import { loadConfigOrThrow } from "../../loadConfig";
import { nodePlatform } from "../../platforms/node";

// The sample config on real hardware, captured with `capture-device-schema`:
// any change to the port, VLAN or radio logic shows up as a snapshot diff.
const root = join(__dirname, "../../..");
const schema = (model: string) =>
  deviceSchemaSchema.parse(
    JSON.parse(
      readFileSync(join(root, "deviceSchemas", `${model}.json`), "utf8")
    )
  );

const cases: [string, string, string][] = [
  ["router", "my-router", "friendlyarm,nanopi-r6s"],
  ["access point", "my-ap-1", "zyxel,nwa50ax-pro"],
];

for (const [role, hostname, model] of cases) {
  test(`the sample ${role} on a ${model}`, async (t) => {
    const { plan } = await loadConfigOrThrow({
      path: join(root, "sampleConfigs/basic.json"),
      platform: nodePlatform,
      lookup: async (name) => `placeholder-${name}`,
    });
    const deviceConfig = {
      ...plan.devices.find((d) => d.hostname === hostname)!,
      model_id: model,
    };
    const openWrtConfig = getOpenWrtConfig({
      plan,
      deviceConfig,
      deviceSchema: schema(model),
    });
    t.snapshot(getUciCommands({ openWrtConfig }));
  });
}
