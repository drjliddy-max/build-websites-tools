# build-websites-tools

Shared build-time enforcement gates for every owned portfolio website. **Build script once, use many.**

> Companion to `~/Desktop/Projects/build-websites-template/` — the methodology (markdown docs). This package is the implementation (executable gates) of the methodology's QA layer.

## What it provides

| Gate | What it enforces |
|--|--|
| `gate-ada` | WCAG 2.1 AA via axe-core/playwright. Fails on any critical/serious/moderate violation across every route in `gate.config.json`. Same engine ada-audit-tool sells as a $49 product. |
| `gate-seo` | Google indexing rules at BUILD TIME: HTTP 200, no `<meta robots noindex>`, no `X-Robots-Tag: noindex`, canonical matches request path, sitemap-vs-routes consistency, robots.txt valid, structural meta (title 10-70ch, description 50-160ch, OG, Twitter card, single h1, heading hierarchy, image alt), JSON-LD present, sitemap-backed route coverage, internal-link canonicality, and optional production SEO architecture gates for server-rendered HTML, health paths, API/data dependencies, cache/CDN headers, and security headers. Blocks the exact failure modes Google flags as "Excluded by noindex," "Page with redirect," and "Discovered, currently not indexed." |

## Consumption pattern (per site)

Each consuming site (`siteclinic-web/`, future ADA rebuild, future daily-rise refresh, etc.) carries **two files only** for gate wiring:

### 1. `package.json` — file dep + scripts

```json
{
  "devDependencies": {
    "build-websites-tools": "file:./tools/build-websites-tools"
  },
  "scripts": {
    "gate:ada": "gate-ada",
    "gate:seo": "gate-seo",
    "gate:all": "npm run gate:ada && npm run gate:seo",
    "prebuild": "npm run gate:all"
  }
}
```

### 2. `gate.config.json` — site-specific config

```json
{
  "routes": ["/", "/about", "/pricing"],
  "baseUrl": "http://localhost:3000",
  "allowedOffSitemapRoutes": ["/thank-you"]
}
```

That's it. No gate logic in the site repo. No copy-pasted scripts. No drift surface.

Important boundary for standalone website repos:

- `file:../build-websites-tools` is only safe inside the parent local workspace
- standalone GitHub/Vercel repos must vendor the package under `tools/build-websites-tools`
- standalone consumers should keep the portable gate contract: browser mode when Chromium is available, truthful JSDOM HTML-snapshot fallback when cloud builders cannot launch Chromium

## Config schema

| Field | Required | Type | Validation |
|--|--|--|--|
| `routes` | yes | `string[]` | Non-empty, every entry must start with `/` |
| `baseUrl` | yes | `string` | Must start with `http://` or `https://`. Can be overridden by `GATE_BASE_URL` env var (useful for running gates against staging or production from CI). |
| `allowedOffSitemapRoutes` | no | `string[]` | Internal same-origin paths intentionally linked but excluded from sitemap (for example a thank-you page). Every entry must start with `/`. |
| `productionSeo` | no | `object` | Optional production SEO architecture gates. Existing configs keep old behavior until this block is added. |

### `productionSeo` schema

```json
{
  "productionSeo": {
    "requireServerRenderedHtml": true,
    "minServerRenderedTextChars": 300,
    "allowClientOnlyRoutes": ["/dashboard"],
    "requiredHealthPaths": ["/status"],
    "requiredApiDependencyPaths": ["/api/public-health"],
    "requireHtmlCacheControl": false,
    "requireStaticAssetCacheControl": false,
    "requireSecurityHeaders": false
  }
}
```

Rules:

- `requireServerRenderedHtml` checks that ranking routes return enough body text and an H1 in HTML before client JavaScript.
- `requiredHealthPaths` checks extra site-specific URLs in addition to `/`, `/sitemap.xml`, and `/robots.txt`.
- `requiredApiDependencyPaths` checks public dependency probes for CMS/API/database-backed pages.
- `requireHtmlCacheControl`, `requireStaticAssetCacheControl`, and `requireSecurityHeaders` are usually best run against staging or production via `GATE_BASE_URL=https://...`, because local dev servers often do not emit final CDN/security headers.
- `allowClientOnlyRoutes` is for protected apps and tools, not money pages, blog posts, service pages, docs, proof pages, or comparison pages.

Validation is strict: malformed or missing `gate.config.json` exits with a loud error message, not a silent default.

## Runtime requirements

Consuming site must have:
- A running web server at `baseUrl` (typically `npm run dev` in another terminal during local development, or `next start` / static-served `site/` for static sites)

The gates assume the routes in `gate.config.json` are reachable at `baseUrl + route`. `gate:seo` is browserless and now also checks every sitemap-backed page plus internal same-origin links, so redirect aliases and orphaned pages fail during the build instead of surfacing later in Search Console. `gate:ada` uses a real browser when Chromium is available and falls back to a JSDOM HTML snapshot when it is not. That keeps standalone cloud builds portable without turning the gate into silent static analysis.

## Status

**Phase 1**: gate-ada + gate-seo, consumed by `siteclinic-web` only.

**Phase B (future)**: extract template scaffolding so `npx create-siteclinic-web` produces a doctrine-compliant site skeleton from a single `site.config.ts` input. Package structure here is already compatible with that shape — don't pre-build the generator until rule-of-three is satisfied (2-3 hand-built consumers).

## Anti-patterns

Refuse:
- Re-implementing `gate:ada` inside a consuming site's `scripts/` directory because "we need a slightly different axe config." Extend the shared gate or accept the shared config.
- Sites that carry their own `gate-*.ts` files. After this package exists, that pattern is a drift surface.
- Bypassing `prebuild` with `--no-verify` or skipping the gate. The "100/100 ADA + Google indexing rules enforced" doctrine is non-negotiable per operator directive 2026-05-11.

## Source

- Operator directives:
  - 2026-05-11 "every owned website must be authored through build-websites-template + design-os-template"
  - 2026-05-11 "build script once, use many"
- Reference memory:
  - `~/.claude/projects/-Users-johnliddy-Desktop-Projects-BabyMilestone/memory/feedback_websites_built_through_builder_tool.md`
  - `~/.claude/projects/-Users-johnliddy-Desktop-Projects-BabyMilestone/memory/feedback_builder_tool_proto_patterns.md`
