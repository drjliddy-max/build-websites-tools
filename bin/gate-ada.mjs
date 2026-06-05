#!/usr/bin/env node
/*
 * Bin wrapper for gate-ada. Invoked by consuming sites via npm script:
 *   "gate:ada": "gate-ada"
 *
 * Spawns tsx (from build-websites-tools' OWN node_modules) to execute
 * src/gate-ada.ts. Resolving tsx via __dirname rather than consumer's
 * cwd keeps consumers zero-dep beyond build-websites-tools itself.
 *
 * Working directory (process.cwd()) stays the consumer's repo — that's
 * where load-config.ts finds gate.config.json.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "..", "src", "gate-ada.ts");
// Resolve tsx via absolute file URL so node's --import finds it in our
// OWN node_modules — consumer sites don't list tsx as a dependency.
const tsxLoaderUrl = pathToFileURL(
  path.join(__dirname, "..", "node_modules", "tsx", "dist", "loader.mjs"),
).href;

const result = spawnSync(process.execPath, ["--import", tsxLoaderUrl, scriptPath], {
  stdio: "inherit",
});
if (result.error) {
  console.error(`Failed to launch gate-ada: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
