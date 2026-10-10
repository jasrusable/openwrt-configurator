// The one definition of how the QuickJS bundle is built, used by
// `npm run bundle` and by the parity test so the two cannot drift apart.
const { buildSync } = require("esbuild");

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

module.exports = { qjsBundleOptions, bundleForQjs };

if (require.main === module) {
  bundleForQjs("bin/qjs.ts", "dist/qjs/openwrt-configurator.mjs");
}
