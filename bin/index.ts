#!/usr/bin/env node
import { run } from "../src/cli";
import { nodePlatform } from "../src/platforms/node";

run({ argv: process.argv.slice(2), platform: nodePlatform });
