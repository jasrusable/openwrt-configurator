// Every captured board, as the tests and the equivalence guard fit configs
// to: the device schemas captured from real devices (and the two old ones),
// and the board fixtures they do not already cover (written to OpenWrt's
// layouts: a Docker rootfs, a multi-radio Wi-Fi 7 board, a swconfig board
// with its WAN beside the switch).
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { DeviceSchema, deviceSchemaSchema } from "../../deviceSchema";
import { parseDeviceFacts } from "../../facts/board";

const repo = join(__dirname, "..", "..", "..");
const read = (...path: string[]) => JSON.parse(readFileSync(join(repo, ...path), "utf8"));

export type RawBoard = { name: string; schema?: unknown; board?: unknown; system?: unknown };

/** As found on disk, for a checkout to read with its own code (scripts/equivalence.ts). */
export const capturedBoardsRaw = (): RawBoard[] => [
  ...readdirSync(join(repo, "deviceSchemas"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f.replace(/\.json$/, ""), schema: read("deviceSchemas", f) })),
  ...["docker-armsr", "wifi7-multiradio", "swconfig-wan-nic"].map((name) => ({
    name,
    board: read("src/tests/helpers/boards", `${name}.board.json`),
    system: read("src/tests/helpers/boards", `${name}.system.json`),
  })),
];

export const capturedBoards = (): { name: string; schema: DeviceSchema }[] =>
  capturedBoardsRaw().map(({ name, schema, board, system }) => ({
    name,
    schema: schema ? deviceSchemaSchema.parse(schema) : parseDeviceFacts({ board, system }),
  }));
