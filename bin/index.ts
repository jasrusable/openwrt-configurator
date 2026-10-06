#!/usr/bin/env node
import "../src/platforms/registerNode";
import { run } from "../src/cli";

run(process.argv.slice(2));
