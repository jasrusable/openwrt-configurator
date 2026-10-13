#!/usr/bin/env node
import { existsSync } from "fs";
import { join } from "path";
import { run } from "../src/cli";
import { blockingStdio, nodePlatform } from "../src/platforms/node";

// Built (dist/bin, or a pkg binary's snapshot), the web UI sits beside the
// program in dist/ui, wherever it is run from; from source, `npm run ui`
// builds it into ./dist/ui.
const besideProgram = join(__dirname, "..", "ui");
const uiDir = existsSync(join(besideProgram, "app.js")) ? besideProgram : undefined;

blockingStdio();
run({ argv: process.argv.slice(2), platform: nodePlatform, uiDir });
