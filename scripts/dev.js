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

const children = [];

// One half dying leaves a confusing half-working setup: stop both, so the
// other (the watcher, or a server holding the port) is not left behind.
const stopAll = (code) => {
  children.forEach((child) => child.exitCode === null && child.kill());
  process.exit(code);
};
process.on("SIGINT", () => stopAll(130));
process.on("SIGTERM", () => stopAll(143));

const run = (command, args) => {
  const child = spawn(command, args, { stdio: "inherit" }).on("exit", (code) => {
    console.error(`${command} exited (${code}); stopping.`);
    stopAll(code ?? 1);
  });
  children.push(child);
};

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
