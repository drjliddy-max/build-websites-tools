/*
 * Drift-prevention contract for gate:ai-instrumentation-source.
 *
 * Three invariants this test file locks against:
 *
 *   1. Multiple-source detection works — if a refactor adds
 *      public/robots.txt while src/app/robots.txt/route.ts still
 *      exists (the liddy-podiatry 2026-06-04 incident pattern),
 *      the gate fails loudly. This regression caused production
 *      HTTP 500 on /robots.txt for 4 days; the gate must catch it
 *      at commit time.
 *
 *   2. MetadataRoute rejection — src/app/robots.ts cannot emit the
 *      declared-policy comment block. The 2026-06-05
 *      participation-effect-site cutover shipped this regression.
 *      The gate refuses MetadataRoute as a valid serving mechanism.
 *
 *   3. Signal preservation — if a refactor switches serving
 *      mechanism while dropping the AI policy comment / Markdown
 *      heading / Organization|WebSite @type, the gate fails before
 *      the build deploys.
 *
 * Run via: npm test (in build-websites-tools).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectHomepageJsonLdTypes,
  evaluateHomepageJsonLd,
  evaluateLlms,
  evaluateRobots,
  evaluateSource,
  findHomepageSource,
  findLlmsSources,
  findRobotsSources,
} from "../gate-ai-instrumentation-source";

// ─── Test fixture helpers ────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gate-source-test-"));
}

function writeFile(cwd: string, rel: string, body: string): void {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function cleanup(cwd: string): void {
  fs.rmSync(cwd, { recursive: true, force: true });
}

const ROBOTS_WITH_POLICY = `# AI policy for example.com — declared 2026-06-05
# Doctrine: MASTER_VISIBILITY_MATRIX §17.3.1.2

User-agent: *
Allow: /
`;

const ROBOTS_BARE = `User-agent: *
Allow: /
Sitemap: https://example.com/sitemap.xml
`;

const LLMS_WITH_HEADING = `# example.com
# Declared 2026-06-05

> Example — does example things.
`;

// ─── Robots invariant ────────────────────────────────────────────────

test("evaluateRobots — passes on single public/robots.txt with policy", () => {
  const cwd = makeTmpDir();
  try {
    writeFile(cwd, "public/robots.txt", ROBOTS_WITH_POLICY);
    const sources = findRobotsSources({ cwd });
    assert.equal(sources.length, 1);
    const r = evaluateRobots(sources);
    assert.equal(r.pass, true);
  } finally {
    cleanup(cwd);
  }
});

test("evaluateRobots — passes on single route handler with policy (in body)", () => {
  const cwd = makeTmpDir();
  try {
    // Route handler with policy literal inside the template body.
    writeFile(
      cwd,
      "src/app/robots.txt/route.ts",
      `export async function GET() { return new Response(\`# AI policy for example.com — declared 2026-06-05\\n\\nUser-agent: *\\nAllow: /\`); }`,
    );
    const r = evaluateRobots(findRobotsSources({ cwd }));
    assert.equal(r.pass, true);
  } finally {
    cleanup(cwd);
  }
});

test("evaluateRobots — FAILS on no robots source (regression: signal removed entirely)", () => {
  const cwd = makeTmpDir();
  try {
    const r = evaluateRobots(findRobotsSources({ cwd }));
    assert.equal(r.pass, false);
    assert.match(r.detail, /no robots\.txt source found/);
  } finally {
    cleanup(cwd);
  }
});

test("evaluateRobots — FAILS on multiple robots sources (liddy-podiatry 2026-06-04 incident class)", () => {
  // Replicates the liddy-podiatry 2026-06-04 production HTTP 500 case:
  // public/robots.txt + route handler both existed. Next.js returned
  // 500 on /robots.txt in production for 4 days.
  const cwd = makeTmpDir();
  try {
    writeFile(cwd, "public/robots.txt", ROBOTS_WITH_POLICY);
    writeFile(
      cwd,
      "src/app/robots.txt/route.ts",
      `export async function GET() { return new Response(\`${ROBOTS_WITH_POLICY}\`); }`,
    );
    const sources = findRobotsSources({ cwd });
    assert.equal(sources.length, 2);
    const r = evaluateRobots(sources);
    assert.equal(r.pass, false);
    assert.match(r.detail, /multiple robots\.txt mechanisms/);
    assert.match(r.detail, /Next\.js will return 500/);
  } finally {
    cleanup(cwd);
  }
});

test("evaluateRobots — REJECTS MetadataRoute (participation-effect cutover 2026-06-05 incident class)", () => {
  // Replicates the participation-effect-site cutover regression:
  // src/app/robots.ts as MetadataRoute.Robots cannot emit the
  // declared-policy comment block. The gate must REFUSE this
  // serving mechanism even if it would technically respond 200.
  const cwd = makeTmpDir();
  try {
    writeFile(
      cwd,
      "src/app/robots.ts",
      `import type { MetadataRoute } from "next";\nexport default function robots(): MetadataRoute.Robots { return { rules: [{ userAgent: "*", allow: "/" }] }; }`,
    );
    const r = evaluateRobots(findRobotsSources({ cwd }));
    assert.equal(r.pass, false);
    assert.match(r.detail, /MetadataRoute/);
    assert.match(r.detail, /cannot emit/);
  } finally {
    cleanup(cwd);
  }
});

test("evaluateRobots — FAILS when source exists but AI policy comment missing (signal-dropping refactor)", () => {
  const cwd = makeTmpDir();
  try {
    writeFile(cwd, "public/robots.txt", ROBOTS_BARE);
    const r = evaluateRobots(findRobotsSources({ cwd }));
    assert.equal(r.pass, false);
    assert.match(r.detail, /missing declared AI policy/);
  } finally {
    cleanup(cwd);
  }
});

test("evaluateRobots — accepts both 'AI policy for X' and 'AI policy —' forms (shipped portfolio variants)", () => {
  for (const opener of [
    "# AI policy for jeffrystein.com — declared 2026-06-04\n\nUser-agent: *\nAllow: /\n",
    "# AI policy — declared 2026-06-03 per MASTER_VISIBILITY_MATRIX §17.3.1.2\n\nUser-agent: *\nAllow: /\n",
  ]) {
    const cwd = makeTmpDir();
    try {
      writeFile(cwd, "public/robots.txt", opener);
      const r = evaluateRobots(findRobotsSources({ cwd }));
      assert.equal(r.pass, true, `failed on opener: ${opener.slice(0, 50)}`);
    } finally {
      cleanup(cwd);
    }
  }
});

// ─── Llms invariant ──────────────────────────────────────────────────

test("evaluateLlms — passes on single public/llms.txt with Markdown heading", () => {
  const cwd = makeTmpDir();
  try {
    writeFile(cwd, "public/llms.txt", LLMS_WITH_HEADING);
    const r = evaluateLlms(findLlmsSources({ cwd }));
    assert.equal(r.pass, true);
  } finally {
    cleanup(cwd);
  }
});

test("evaluateLlms — FAILS on no llms.txt source", () => {
  const cwd = makeTmpDir();
  try {
    const r = evaluateLlms(findLlmsSources({ cwd }));
    assert.equal(r.pass, false);
    assert.match(r.detail, /no llms\.txt source/);
  } finally {
    cleanup(cwd);
  }
});

test("evaluateLlms — FAILS on multiple llms.txt mechanisms (conflict)", () => {
  const cwd = makeTmpDir();
  try {
    writeFile(cwd, "public/llms.txt", LLMS_WITH_HEADING);
    writeFile(
      cwd,
      "src/app/llms.txt/route.ts",
      `export async function GET() { return new Response("# example.com\\n"); }`,
    );
    const r = evaluateLlms(findLlmsSources({ cwd }));
    assert.equal(r.pass, false);
    assert.match(r.detail, /multiple llms\.txt mechanisms/);
  } finally {
    cleanup(cwd);
  }
});

test("evaluateLlms — FAILS when source has no Markdown heading", () => {
  const cwd = makeTmpDir();
  try {
    writeFile(cwd, "public/llms.txt", "no heading here, just prose\n");
    const r = evaluateLlms(findLlmsSources({ cwd }));
    assert.equal(r.pass, false);
    assert.match(r.detail, /no Markdown heading/);
  } finally {
    cleanup(cwd);
  }
});

// ─── JSON-LD source invariant ────────────────────────────────────────

test("detectHomepageJsonLdTypes — extracts double-quoted types", () => {
  const body = `
    const jsonLd = \`{
      "@type": "Organization",
      "name": "Example"
    }\`;
  `;
  assert.deepEqual(detectHomepageJsonLdTypes(body), ["Organization"]);
});

test("detectHomepageJsonLdTypes — extracts single-quoted types (React inline)", () => {
  const body = `<script type='application/ld+json'>{'@type': 'WebSite'}</script>`;
  assert.deepEqual(detectHomepageJsonLdTypes(body), ["WebSite"]);
});

test("detectHomepageJsonLdTypes — extracts @type array literals", () => {
  const body = `"@type": ["Organization", "Service"]`;
  assert.deepEqual(detectHomepageJsonLdTypes(body).sort(), ["Organization", "Service"]);
});

test("detectHomepageJsonLdTypes — extracts multiple @type in @graph", () => {
  const body = `
    const jsonLd = \`{
      "@graph": [
        { "@type": "Organization" },
        { "@type": "WebSite" },
        { "@type": "MedicalBusiness" }
      ]
    }\`;
  `;
  const types = detectHomepageJsonLdTypes(body);
  assert.deepEqual(types.sort(), ["MedicalBusiness", "Organization", "WebSite"]);
});

test("evaluateHomepageJsonLd — FAILS when no homepage source found", () => {
  const cwd = makeTmpDir();
  try {
    const r = evaluateHomepageJsonLd({ cwd });
    assert.equal(r.pass, false);
    assert.match(r.detail, /no homepage source found/);
  } finally {
    cleanup(cwd);
  }
});

test("evaluateHomepageJsonLd — FAILS when homepage + layout + components all lack @type (full signal removal)", () => {
  // Replicates a refactor that strips JSON-LD entirely from the
  // source tree. The gate scans the homepage corpus (page +
  // layout + shared schema components); if none of them declare
  // any @type, the matrix signal is missing.
  const cwd = makeTmpDir();
  try {
    writeFile(cwd, "src/app/page.tsx", `export default function Home() { return <h1>Hi</h1>; }`);
    const r = evaluateHomepageJsonLd({ cwd });
    assert.equal(r.pass, false);
    assert.match(r.detail, /no JSON-LD @type literal/);
  } finally {
    cleanup(cwd);
  }
});

test("evaluateHomepageJsonLd — FAILS when JSON-LD exists but only non-canonical types (e.g., MedicalBusiness only)", () => {
  // Replicates the liddy-podiatry 2026-06-05 pre-fix state — homepage
  // had MedicalBusiness + Physician but no Organization or WebSite.
  const cwd = makeTmpDir();
  try {
    writeFile(
      cwd,
      "src/app/page.tsx",
      `const jsonLd = \`{"@type": "MedicalBusiness", "@type": "Physician"}\`;`,
    );
    const r = evaluateHomepageJsonLd({ cwd });
    assert.equal(r.pass, false);
    assert.match(r.detail, /neither Organization nor WebSite/);
  } finally {
    cleanup(cwd);
  }
});

test("evaluateHomepageJsonLd — passes when Organization present", () => {
  const cwd = makeTmpDir();
  try {
    writeFile(
      cwd,
      "src/app/page.tsx",
      `const jsonLd = \`{"@type": "Organization", "name": "Example"}\`;`,
    );
    const r = evaluateHomepageJsonLd({ cwd });
    assert.equal(r.pass, true);
  } finally {
    cleanup(cwd);
  }
});

test("evaluateHomepageJsonLd — passes when WebSite present alongside other types", () => {
  const cwd = makeTmpDir();
  try {
    writeFile(
      cwd,
      "src/app/page.tsx",
      `const jsonLd = \`{"@graph": [{"@type": "WebSite"}, {"@type": "Book"}]}\`;`,
    );
    const r = evaluateHomepageJsonLd({ cwd });
    assert.equal(r.pass, true);
  } finally {
    cleanup(cwd);
  }
});

// ─── End-to-end aggregate ────────────────────────────────────────────

test("evaluateSource — fails fast with all 3 issues surfaced on empty repo", () => {
  const cwd = makeTmpDir();
  try {
    const result = evaluateSource({ cwd });
    assert.equal(result.pass, false);
    assert.equal(result.checks.length, 3);
    for (const c of result.checks) {
      assert.equal(c.pass, false);
    }
  } finally {
    cleanup(cwd);
  }
});

test("evaluateSource — passes when all 3 invariants hold (canonical owned-site shape)", () => {
  const cwd = makeTmpDir();
  try {
    writeFile(cwd, "public/robots.txt", ROBOTS_WITH_POLICY);
    writeFile(cwd, "public/llms.txt", LLMS_WITH_HEADING);
    writeFile(
      cwd,
      "src/app/page.tsx",
      `const jsonLd = \`{"@graph":[{"@type":"Organization"},{"@type":"WebSite"}]}\`;`,
    );
    const result = evaluateSource({ cwd });
    assert.equal(result.pass, true);
  } finally {
    cleanup(cwd);
  }
});
