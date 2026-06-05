#!/usr/bin/env node
/*
 * Bin wrapper for gate-ai-instrumentation-source. Invoked by consuming
 * sites via npm script:
 *   "gate:ai-instrumentation-source": "gate-ai-instrumentation-source"
 *
 * Spawns tsx to execute src/gate-ai-instrumentation-source.ts. tsx is
 * resolved via Node's standard module resolution (createRequire from
 * this script's URL) so it works in both install topologies (file:
 * vendored OR github tarball fetched). Consumer sites don't list tsx
 * as a dependency.
 *
 * Working directory (process.cwd()) stays the consumer's repo — that's
 * where load-config.ts finds gate.config.json AND where the static
 * source scan looks for robots/llms/page source files.
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
  "gate-ai-instrumentation-source.ts",
);

const require = createRequire(import.meta.url);
const tsxLoaderUrl = pathToFileURL(require.resolve("tsx")).href;

const result = spawnSync(process.execPath, ["--import", tsxLoaderUrl, scriptPath], {
  stdio: "inherit",
});
if (result.error) {
  console.error(
    `Failed to launch gate-ai-instrumentation-source: ${result.error.message}`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
