// The command line: each command a spec (src/args.ts, no commander) built
// from the platform it runs on, in src/cli/. `bin/index.ts` (Node) and
// `bin/qjs.ts` (QuickJS) only build their platform and call `run`.
import { messageOf } from "../result";
import { runCli } from "../args";
import { confirmTiming } from "../apply/reconnect";
import { CommandFailed } from "./context";
import { Platform } from "../platform";
import { buildImagesCommand, verifyImagesCommand } from "./images";
import { compileCommand, printUciCommand } from "./config";
import { CliContext } from "./context";
import { provisionCommand } from "./provision";
import { captureSchemaCommand } from "./schema";
import { secretsCommand } from "./secrets";
import { cgiCommand, collectCommand, uiCommand } from "./serve";

export const main = async ({
  argv,
  platform,
  uiDir = "dist/ui",
}: {
  argv: string[];
  platform: Platform;
  /** Where the built web UI is, unless --ui-dir says: the entry point knows. */
  uiDir?: string;
}) => {
  const timing = confirmTiming(platform.env("ONC_TEST_MIN_CONFIRM_WINDOW"));
  if (timing.shortened) {
    console.warn(
      `Warning: ONC_TEST_MIN_CONFIRM_WINDOW shortens the confirm window to ` +
        `${timing.minimumConfirmWindowMs / 1000}s. For tests only.`
    );
  }
  const context: CliContext = { platform, timing, uiDir };
  await runCli(
    {
      name: "openwrt-configurator",
      description: "OpenWrt Configurator",
      version: "0.1.1",
      // In the order help lists them.
      commands: [
        provisionCommand,
        compileCommand,
        uiCommand,
        collectCommand,
        cgiCommand,
        printUciCommand,
        buildImagesCommand,
        captureSchemaCommand,
        verifyImagesCommand,
        secretsCommand,
      ].map((command) => command(context)),
    },
    argv
  );
};

/** Run the CLI on the given platform, exiting when done. */
export const run = (options: Parameters<typeof main>[0]) =>
  main(options)
    .then(() => options.platform.exit(0))
    .catch((e) => {
      // Without this a failure surfaces as an unhandled rejection and a stack
      // trace rather than a readable message.
      console.error(`\nError: ${messageOf(e)}`);
      options.platform.exit(e instanceof CommandFailed ? e.exitCode : 1);
    });
