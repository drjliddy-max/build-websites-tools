#!/usr/bin/env node
/*
 * Shared launcher used by every bin entry (gate-ada, gate-seo,
 * gate-ai-instrumentation, gate-ai-instrumentation-source). Spawns
 * tsx to execute the matching TypeScript source under src/.
 *
 * Why createRequire + bare specifier (not a subpath import):
 *   tsx exposes only its package "exports" entry. require.resolve("tsx")
 *   yields the file the exports map points at, which is what `node
 *   --import` wants. Subpaths like "tsx/dist/loader.mjs" are NOT exposed
 *   and would fail with ERR_PACKAGE_PATH_NOT_EXPORTED. createRequire is
 *   used because import.meta.resolve is still flagged behind the
 *   experimental loader in some Node minors we support.
 *
 * Why we keep process.cwd() unchanged: load-config.ts and the source
 * scans read gate.config.json + site files relative to the consuming
 * site repo, not relative to this bin wrapper.
 *
 * Two install topologies both work:
 *   file:../build-websites-tools         (sibling-path dep)
 *   github:drjliddy-max/build-websites-tools#vX.Y.Z
 * In both, npm hoists tsx to the consumer's node_modules where
 * createRequire can find it.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

/**
 * @param {object} opts
 * @param {string} opts.binFileUrl  import.meta.url from the calling bin entry
 * @param {string} opts.scriptName  the .ts file under src/ to run (no extension)
 * @param {string} opts.gateLabel   user-facing label for the error message
 */
export function runGate({ binFileUrl, scriptName, gateLabel }) {
  const binDir = path.dirname(fileURLToPath(binFileUrl));
  const scriptPath = path.join(binDir, "..", "src", `${scriptName}.ts`);

  const require = createRequire(binFileUrl);
  const tsxLoaderUrl = pathToFileURL(require.resolve("tsx")).href;

  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoaderUrl, scriptPath],
    { stdio: "inherit" },
  );
  if (result.error) {
    console.error(`Failed to launch ${gateLabel}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
