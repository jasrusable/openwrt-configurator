// Builds the web UI into dist/ui: index.html, app.js and app.css. Static
// files only, so any server can serve them: `onc ui` on a Mac or Raspberry
// Pi, or `onc cgi` under uhttpd on a router.
//
//   --watch  rebuild on change
//   --dev    unminified, with source maps, and the page reloads itself after
//            each rebuild (it polls build-id.txt, which every build rewrites)
const { context } = require("esbuild");
const { copyFileSync, mkdirSync, writeFileSync } = require("fs");

const outdir = "dist/ui";
const dev = process.argv.includes("--dev");

// Dev only: reload when the build id changes. Polling the normal static
// server needs no second server, port or proxy.
const liveReload = `(() => {
  let seen;
  setInterval(async () => {
    const id = await fetch("build-id.txt", { cache: "no-store" })
      .then((r) => r.text())
      .catch(() => seen);
    if (seen !== undefined && id !== seen) location.reload();
    seen = id;
  }, 1000);
})();`;

const writeBuildId = {
  name: "build-id",
  setup: (build) =>
    build.onEnd(() => writeFileSync(`${outdir}/build-id.txt`, String(Date.now()))),
};

const main = async () => {
  mkdirSync(outdir, { recursive: true });
  copyFileSync("ui/index.html", `${outdir}/index.html`);
  const ctx = await context({
    entryPoints: { app: "ui/src/main.tsx" },
    bundle: true,
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    format: "esm",
    target: "es2020",
    jsx: "automatic",
    outdir,
    define: { "process.env.NODE_ENV": dev ? '"development"' : '"production"' },
    banner: dev ? { js: liveReload } : undefined,
    plugins: [writeBuildId],
    logLevel: "info",
  });
  if (process.argv.includes("--watch")) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
