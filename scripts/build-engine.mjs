import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = resolve(root, "htdocs/luci-static/resources/singsing/engine-bundle.js");
const apiPath = resolve(root, "htdocs/luci-static/resources/singsing/api.js");

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
  outfile: bundlePath,
  banner: {
    js: "/* luci-app-singsing engine bundle - generated from src/upstream + src/adapter */",
  },
});

// Stamp content hash into api.js so OpenWrt SDK packages (identical SOURCE_DATE_EPOCH)
// always bust browser cache on upgrade when loading engine-bundle.js.
const rev = createHash("sha256").update(readFileSync(bundlePath)).digest("hex").slice(0, 12);
const apiSrc = readFileSync(apiPath, "utf8");
const updatedApi = apiSrc.replace(/var ENGINE_BUNDLE_REV = '[^']*';/, `var ENGINE_BUNDLE_REV = '${rev}';`);
if (updatedApi === apiSrc && !apiSrc.includes(`var ENGINE_BUNDLE_REV = '${rev}';`)) {
  throw new Error("Could not find ENGINE_BUNDLE_REV placeholder in api.js");
}
if (updatedApi !== apiSrc) {
  writeFileSync(apiPath, updatedApi);
}

console.log(`Built htdocs/luci-static/resources/singsing/engine-bundle.js (rev=${rev})`);
