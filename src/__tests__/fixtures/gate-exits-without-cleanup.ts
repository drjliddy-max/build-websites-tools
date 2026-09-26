/*
 * Test fixture: a gate that launches its server through ensureBaseUrlReady and
 * then leaves via process.exit(1) WITHOUT calling the returned cleanup, which
 * is exactly what gate-seo's FAIL path did before site-monitor#273. The test
 * drives this file through execFile, the same way the blog-writer publisher
 * drives `npm run gate:seo`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureBaseUrlReady } from "../../ensure-base-url";
import type { GateConfig } from "../../load-config";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.GATE_FIXTURE_PORT);

await ensureBaseUrlReady({
  baseUrl: `http://127.0.0.1:${port}`,
  launchCommand: `node ${path.join(here, "launch-wrapper.mjs")}`,
  startupTimeoutMs: 15_000,
  routes: [],
} as unknown as GateConfig);

process.exit(1);
