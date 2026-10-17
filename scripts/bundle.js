// The one definition of how the QuickJS bundle is built, used by
// `npm run bundle` and by the parity test so the two cannot drift apart.
const { buildSync } = require("esbuild");
const { cpSync, existsSync } = require("fs");

const qjsBundleOptions = {
  bundle: true,
  minify: true,
  format: "esm",
  platform: "neutral",
  // ESM builds first: a UMD `main` (jsonc-parser's) does a dynamic require
  // that QuickJS cannot satisfy.
  mainFields: ["module", "main"],
  external: ["std", "os"],
  logLevel: "error",
};

const bundleForQjs = (entry, outfile) =>
  buildSync({ ...qjsBundleOptions, entryPoints: [entry], outfile });

// The Node build in one file, with the web UI beside it (bin/index.ts finds
// it at ../ui): what Homebrew installs, as QuickJS cannot serve the UI.
// ssh2's native addons are optional; it falls back to plain JS without them.
const bundleForNode = (outdir) => {
  buildSync({
    ...qjsBundleOptions,
    platform: "node",
    target: "node24",
    format: "cjs",
    external: ["cpu-features", "*.node"],
    entryPoints: ["bin/index.ts"],
    outfile: `${outdir}/bin/openwrt-configurator.js`,
  });
  cpSync("dist/ui", `${outdir}/ui`, { recursive: true });
};

module.exports = { qjsBundleOptions, bundleForQjs, bundleForNode };

if (require.main === module) {
  bundleForQjs("bin/qjs.ts", "dist/qjs/openwrt-configurator.mjs");
  if (existsSync("dist/ui/app.js")) bundleForNode("dist/node/openwrt-configurator");
}
