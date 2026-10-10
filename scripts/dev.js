// Development on a Mac: the UI rebuilds and reloads itself on change, and the
// backend restarts when its code changes. Usage: npm run dev -- <intent-file>
// [--port 8080]. Production is `npm run ui:build` then `onc ui` (or `onc cgi`
// under uhttpd on a router).
const { spawn } = require("child_process");

const [intentPath, ...rest] = process.argv.slice(2);
if (!intentPath) {
  console.error("Usage: npm run dev -- <intent-file> [--port 8080]");
  process.exit(2);
}

const run = (command, args) =>
  spawn(command, args, { stdio: "inherit" }).on("exit", (code) => {
    // One half dying leaves a confusing half-working setup: stop both.
    console.error(`${command} exited (${code}); stopping.`);
    process.exit(code ?? 1);
  });

run(process.execPath, ["scripts/build-ui.js", "--watch", "--dev"]);
run(process.execPath, [
  "--watch-path=src",
  "--watch-path=bin",
  "-r",
  "ts-node/register/transpile-only",
  "bin/index.ts",
  "ui",
  intentPath,
  ...rest,
]);
