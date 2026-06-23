/*
 * gate:dashboard-parity - site-side dashboard-readiness meta-gate.
 *
 * Board-parity doctrine (MASTER_VISIBILITY_MATRIX §17.3.1.2, three-pillar
 * standard, 2026-06-21/22): every operated marketing site must ship every
 * surface a Site Clinic parity dashboard reads. This gate enforces the SITE
 * side of that promise at build time by COMPOSING the existing readiness gates
 * - it does not duplicate their logic, it runs them and aggregates the result.
 *
 * Phase 3, Option A (chosen 2026-06-22): site-side composition only. Option B
 * (a shared pipeline manifest cross-checked against site-monitor's registries)
 * is intentionally DEFERRED - the board-side registration is already enforced
 * by site-monitor's billableClientParity contract test.
 *
 * Required readiness surfaces (the build-time / static-capable gates; the AI
 * runtime probe needs a live server, so the -source variant is composed here):
 *   - gate:ada                               - accessibility (WCAG 2.1 AA)
 *   - gate:seo                               - indexability / canonical / schema
 *   - gate:ai-instrumentation-source         - llms.txt / robots AI policy / JSON-LD / GA4
 *   - gate:conversion-instrumentation-source - /api/track relay + consent-independent dual-fire
 *
 * This file reads nothing itself; each composed gate reads gate.config.json
 * from the consuming site's cwd (process.cwd() is preserved across the spawn).
 * Site-agnostic: zero site-specific assumptions.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RequiredGate {
  /** the src/<script>.ts gate to compose */
  script: string;
  /** user-facing label */
  label: string;
}

/**
 * The dashboard-readiness surfaces every operated marketing site must ship.
 * Adding a board-required surface here makes it mandatory for every consuming
 * site that wires gate:dashboard-parity - the site-side mirror of site-monitor's
 * truth-layer parity contract.
 */
export const REQUIRED_READINESS_GATES: readonly RequiredGate[] = [
  { script: "gate-ada", label: "gate:ada (accessibility)" },
  { script: "gate-seo", label: "gate:seo (indexing/canonical/schema)" },
  {
    script: "gate-ai-instrumentation-source",
    label: "gate:ai-instrumentation-source (llms.txt/robots-AI/JSON-LD/GA4)",
  },
  {
    script: "gate-conversion-instrumentation-source",
    label: "gate:conversion-instrumentation-source (/api/track relay)",
  },
];

export interface GateResult {
  label: string;
  ok: boolean;
}

/** Pure aggregation: pass only if EVERY required readiness gate passed. */
export function aggregateGateResults(results: GateResult[]): {
  ok: boolean;
  failed: string[];
} {
  const failed = results.filter((r) => !r.ok).map((r) => r.label);
  return { ok: failed.length === 0, failed };
}

/** Spawn one composed gate (reusing tsx), preserving the consuming site's cwd. */
function runComposedGate(scriptName: string, srcDir: string): boolean {
  const require = createRequire(import.meta.url);
  const tsxEntry = require.resolve("tsx");
  const scriptPath = path.join(srcDir, `${scriptName}.ts`);
  const res = spawnSync(process.execPath, ["--import", tsxEntry, scriptPath], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  return res.status === 0;
}

async function main(): Promise<void> {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  console.log(
    "gate:dashboard-parity - composing dashboard-readiness gates (Phase 3 Option A, site-side):",
  );
  const results: GateResult[] = [];
  for (const gate of REQUIRED_READINESS_GATES) {
    console.log(`\n──────── ${gate.label} ────────`);
    results.push({ label: gate.label, ok: runComposedGate(gate.script, srcDir) });
  }
  const { ok, failed } = aggregateGateResults(results);
  if (!ok) {
    console.error(
      `\ngate:dashboard-parity  FAIL: this site is missing required dashboard-readiness surfaces, so its Site Clinic board cannot reach parity:\n  - ${failed.join(
        "\n  - ",
      )}\nFix the failing gate(s) above - every operated site must ship every board-readable surface.`,
    );
    process.exit(1);
  }
  console.log(
    "\ngate:dashboard-parity  PASS - site ships every dashboard-readiness surface a parity board needs.",
  );
}

// Self-execute ONLY when invoked directly, so tests can import the policy
// helpers (REQUIRED_READINESS_GATES, aggregateGateResults) without spawning the
// composed gates.
const invokedDirectly =
  !!process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
