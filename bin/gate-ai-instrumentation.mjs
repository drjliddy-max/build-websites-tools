#!/usr/bin/env node
/*
 * Bin wrapper for gate-ai-instrumentation. Invoked by consuming sites via:
 *   "gate:ai-instrumentation": "gate-ai-instrumentation"
 *
 * Spawns tsx to execute src/gate-ai-instrumentation.ts. tsx is resolved
 * via Node's standard module resolution (createRequire from this
 * script's URL) so it works in both install topologies (file: vendored
 * OR github tarball fetched). require.resolve("tsx") — bare specifier —
 * uses tsx's package.json exports mapping; subpaths like
 * "tsx/dist/loader.mjs" are NOT exposed by tsx and would fail with
 * ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 * Working directory (process.cwd()) stays the consumer's repo — that's
 * where load-config.ts finds gate.config.json.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(
  __dirname,
  "..",
  "src",
  "gate-ai-instrumentation.ts",
);

const require = createRequire(import.meta.url);
const tsxLoaderUrl = pathToFileURL(require.resolve("tsx")).href;

const result = spawnSync(process.execPath, ["--import", tsxLoaderUrl, scriptPath], {
  stdio: "inherit",
});
if (result.error) {
  console.error(
    `Failed to launch gate-ai-instrumentation: ${result.error.message}`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
