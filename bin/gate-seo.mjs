#!/usr/bin/env node
/*
 * Bin wrapper for gate-seo. Invoked by consuming sites via npm script:
 *   "gate:seo": "gate-seo"
 *
 * Spawns tsx to execute src/gate-seo.ts. tsx is resolved via Node's
 * standard module resolution (createRequire from this script's URL) so
 * it works in both install topologies:
 *   - file:./tools/build-websites-tools — npm hoists tsx to the
 *     consumer's top-level node_modules
 *   - github:drjliddy-max/build-websites-tools#vX.Y.Z — npm hoists tsx
 *     the same way after fetching the github tarball
 *
 * Note: require.resolve("tsx") — bare specifier — uses tsx's package.json
 * `exports` mapping ("." -> "./dist/loader.mjs"). Subpath like
 * "tsx/dist/loader.mjs" is NOT a valid resolve target because tsx does
 * not expose that subpath in its exports field.
 *
 * Working directory (process.cwd()) stays the consumer's repo — that's
 * where load-config.ts finds gate.config.json.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "..", "src", "gate-seo.ts");

const require = createRequire(import.meta.url);
const tsxLoaderUrl = pathToFileURL(require.resolve("tsx")).href;

const result = spawnSync(process.execPath, ["--import", tsxLoaderUrl, scriptPath], {
  stdio: "inherit",
});
if (result.error) {
  console.error(`Failed to launch gate-seo: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
