import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// LuCI browser bundle: AMD/global-friendly IIFE exposing `window.SingboxConfgen`
// and also loadable via LuCI's `'require singsing.engine'` wrapper.
await build({
  entryPoints: [resolve(root, "src/adapter/index.ts")],
  bundle: true,
  format: "iife",
  globalName: "SingboxConfgen",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  sourcemap: false,
  outfile: resolve(root, "htdocs/luci-static/resources/singsing/engine-bundle.js"),
  banner: {
    js: "/* luci-app-singsing engine bundle - generated from src/upstream + src/adapter */",
  },
});

console.log("Built htdocs/luci-static/resources/singsing/engine-bundle.js");
