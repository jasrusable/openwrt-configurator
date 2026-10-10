// Builds the web UI into dist/ui: index.html, app.js and app.css. Static
// files only, so any server can serve them: `onc ui` on a Mac, or `onc cgi`
// under uhttpd on a router. `--watch` rebuilds on change.
const { context } = require("esbuild");
const { copyFileSync, mkdirSync } = require("fs");

const outdir = "dist/ui";

const main = async () => {
  mkdirSync(outdir, { recursive: true });
  copyFileSync("ui/index.html", `${outdir}/index.html`);
  const ctx = await context({
    entryPoints: { app: "ui/src/main.tsx" },
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2020",
    jsx: "automatic",
    outdir,
    define: { "process.env.NODE_ENV": '"production"' },
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
