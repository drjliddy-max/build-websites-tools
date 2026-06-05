#!/usr/bin/env node
/*
 * Bin wrapper for gate-ai-instrumentation. Invoked by consuming sites via:
 *   "gate:ai-instrumentation": "gate-ai-instrumentation"
 *
 * Spawns tsx (from build-websites-tools' OWN node_modules) to execute
 * src/gate-ai-instrumentation.ts. Resolving tsx via __dirname rather
 * than consumer's cwd keeps consumers zero-dep beyond
 * build-websites-tools itself.
 *
 * Working directory (process.cwd()) stays the consumer's repo — that's
 * where load-config.ts finds gate.config.json.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(
  __dirname,
  "..",
  "src",
  "gate-ai-instrumentation.ts",
);

const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
  stdio: "inherit",
});
if (result.error) {
  console.error(
    `Failed to launch gate-ai-instrumentation: ${result.error.message}`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
