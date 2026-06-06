/*
 * Drift-prevention contract for gate:ai-instrumentation.
 *
 * Per feedback_drift_prevention_mandatory.md (operator directive
 * 2026-06-05): every drift-prone surface ships its guard in the same
 * PR. This file locks the gate's detection helpers against future
 * regression of the detection patterns themselves.
 *
 * Concrete drift surfaces this file protects:
 *
 *   - GA4 detection: must match BOTH the gtag('config', 'G-…') style
 *     used by consent-gated wrappers AND the gtag/js?id=G-… loader
 *     used by pre-consent static includes. If a refactor breaks one,
 *     the dashboard quietly under-reports GA4 coverage.
 *   - robots.txt AI policy detection: must match the canonical
 *     comment block shipped by all 7 owned-property robots.txt
 *     route handlers (siteclinic-web 015bdfa, jeffrystein-web a3ce3fb,
 *     adaauditreport-web 0e2daa0, babymilestonejournal-web eae1271,
 *     daily-rise 22959cd, liddy-podiatry-site 1e2422b,
 *     participation-effect-site fcf013f). If the pattern drifts away
 *     from the shipped artifacts, gate goes red on every owned site
 *     simultaneously.
 *   - JSON-LD extraction: must handle entity-encoded `+` per §3.1.3
 *     layer 7 (efileforme.com 2026-06-01 incident class).
 *   - llms.txt shape check: must match the Markdown-heading shape
 *     shipped by all 7 owned-property llms.txt artifacts.
 *
 * Run via: npm test (in build-websites-tools).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectGA4,
  isMarkdownShaped,
  hasRobotsAiPolicy,
  extractJsonLdTypes,
  evaluateJsonLd,
} from "../gate-ai-instrumentation";

// ─────────── GA4 detection ───────────

test("detectGA4 — matches gtag('config', 'G-...') call (consent-gated)", () => {
  const html = `<script>gtag('config', 'G-CKCC40VRPH');</script>`;
  const r = detectGA4(html);
  assert.equal(r.pass, true);
  assert.match(r.detail, /gtag\('config'/);
});

test("detectGA4 — matches googletagmanager.com loader (pre-consent)", () => {
  const html = `<script src="https://www.googletagmanager.com/gtag/js?id=G-CKCC40VRPH" async></script>`;
  const r = detectGA4(html);
  assert.equal(r.pass, true);
  assert.match(r.detail, /googletagmanager/);
});

test("detectGA4 — matches double-quoted gtag form", () => {
  const html = `<script>gtag("config", "G-ABC123DEF");</script>`;
  const r = detectGA4(html);
  assert.equal(r.pass, true);
});

test("detectGA4 — fails on empty HTML", () => {
  const r = detectGA4("");
  assert.equal(r.pass, false);
  assert.match(r.detail, /no GA4/i);
});

test("detectGA4 — fails on UA-style ID (legacy ga.js — not GA4)", () => {
  const html = `<script>ga('create', 'UA-12345678-1', 'auto');</script>`;
  const r = detectGA4(html);
  assert.equal(r.pass, false);
});

test("detectGA4 — fails on bare 'G-' prefix without surrounding gtag context", () => {
  const html = `<p>Our model number is G-1000 series</p>`;
  const r = detectGA4(html);
  assert.equal(r.pass, false);
});

// ─────────── llms.txt shape ───────────

test("isMarkdownShaped — accepts canonical owned-site llms.txt opening", () => {
  const body = `# siteclinic.io\n# Declared 2026-06-04\n\n> Site Clinic — AI visibility…`;
  assert.equal(isMarkdownShaped(body), true);
});

test("isMarkdownShaped — fails on bare prose without heading", () => {
  assert.equal(
    isMarkdownShaped("This is just prose with no Markdown heading anywhere"),
    false,
  );
});

test("isMarkdownShaped — fails on empty body", () => {
  assert.equal(isMarkdownShaped(""), false);
});

test("isMarkdownShaped — fails on '#' without space (not a heading)", () => {
  assert.equal(isMarkdownShaped("#no-space-after-hash"), false);
});

// ─────────── robots.txt AI policy ───────────

test("hasRobotsAiPolicy — matches canonical 'AI policy for <site>' form (5 sites)", () => {
  // Pattern shipped by jeffrystein-web, adaauditreport-web,
  // babymilestonejournal-web, daily-rise, liddy-podiatry-site.
  const body = `# AI policy for jeffrystein.com — declared 2026-06-04
# Doctrine: MASTER_VISIBILITY_MATRIX §17.3.1.2

User-agent: GPTBot
Allow: /
`;
  assert.equal(hasRobotsAiPolicy(body), true);
});

test("hasRobotsAiPolicy — matches alternate 'AI policy — declared' form (siteclinic.io)", () => {
  // Pattern shipped by siteclinic-web.
  const body = `# AI policy — declared 2026-06-03 per MASTER_VISIBILITY_MATRIX §17.3.1.2

User-agent: *
Allow: /
`;
  assert.equal(hasRobotsAiPolicy(body), true);
});

test("hasRobotsAiPolicy — case-insensitive (handles 'AI Policy' or 'ai policy')", () => {
  assert.equal(hasRobotsAiPolicy("# ai policy for example.com"), true);
  assert.equal(hasRobotsAiPolicy("# AI POLICY FOR example.com"), true);
});

test("hasRobotsAiPolicy — fails on bare allow-all without declared policy", () => {
  const body = `User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml`;
  assert.equal(hasRobotsAiPolicy(body), false);
});

test("hasRobotsAiPolicy — fails on allow-all + sitemap only (the pre-fix participation-effect-site shape)", () => {
  const body = `User-agent: *\nAllow: /\nSitemap: https://www.theparticipationeffect.com/sitemap.xml`;
  assert.equal(hasRobotsAiPolicy(body), false);
});

// ─────────── JSON-LD extraction (§3.1.3 layer 7) ───────────

test("extractJsonLdTypes — extracts Organization + WebSite types", () => {
  const html = `
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Organization","name":"X"}
    </script>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"WebSite","url":"https://example.com"}
    </script>
  `;
  const types = extractJsonLdTypes(html);
  assert.deepEqual(types.sort((a, b) => a.localeCompare(b)), ["Organization", "WebSite"]);
});

test("extractJsonLdTypes — handles @graph nested types", () => {
  const html = `
    <script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"Organization","name":"X"},
        {"@type":"WebSite","url":"https://example.com"}
      ]}
    </script>
  `;
  const types = extractJsonLdTypes(html);
  assert.deepEqual(types.sort((a, b) => a.localeCompare(b)), ["Organization", "WebSite"]);
});

test("extractJsonLdTypes — JSDOM decodes entity-encoded type attribute (§3.1.3 layer 7)", () => {
  // efileforme.com 2026-06-01 incident class: ASP.NET Razor template
  // entity-encodes the `+` in `application/ld+json` as `application/ld&#x2B;json`.
  // Browsers + Google decode it; literal-bytes regex did not. JSDOM
  // decodes entities on parsing, so extractJsonLdTypes works correctly
  // even when the raw HTML has the entity-encoded MIME type.
  const html = `
    <script type="application/ld&#x2B;json">
      {"@context":"https://schema.org","@type":"Organization","name":"X"}
    </script>
  `;
  const types = extractJsonLdTypes(html);
  assert.deepEqual(types, ["Organization"]);
});

test("extractJsonLdTypes — empty array on malformed JSON", () => {
  const html = `<script type="application/ld+json">not json</script>`;
  const types = extractJsonLdTypes(html);
  assert.deepEqual(types, []);
});

test("extractJsonLdTypes — handles @type as array", () => {
  const html = `
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":["Organization","Service"],"name":"X"}
    </script>
  `;
  const types = extractJsonLdTypes(html);
  assert.deepEqual(types.sort((a, b) => a.localeCompare(b)), ["Organization", "Service"]);
});

// ─────────── evaluateJsonLd integration ───────────

test("evaluateJsonLd — pass when Organization present", () => {
  const html = `<script type="application/ld+json">{"@type":"Organization","name":"X"}</script>`;
  const r = evaluateJsonLd(html);
  assert.equal(r.pass, true);
});

test("evaluateJsonLd — pass when only WebSite present", () => {
  const html = `<script type="application/ld+json">{"@type":"WebSite","url":"https://x.com"}</script>`;
  const r = evaluateJsonLd(html);
  assert.equal(r.pass, true);
});

test("evaluateJsonLd — fail when no JSON-LD on page", () => {
  const html = `<html><body>No structured data here.</body></html>`;
  const r = evaluateJsonLd(html);
  assert.equal(r.pass, false);
  assert.match(r.detail, /no parse-clean JSON-LD/);
});

test("evaluateJsonLd — fail when JSON-LD has neither Organization nor WebSite", () => {
  // e.g., only Book or only Service — would be a content site with no
  // entity declaration. Spec §17.3.1.2 requires at minimum one of the
  // two on the homepage.
  const html = `<script type="application/ld+json">{"@type":"Book","name":"X"}</script>`;
  const r = evaluateJsonLd(html);
  assert.equal(r.pass, false);
  assert.match(r.detail, /neither Organization nor WebSite/);
});
