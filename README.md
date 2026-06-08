# build-websites-tools

Build-time enforcement gates for production websites. WCAG 2.1 AA accessibility, Google indexing rules, and AI instrumentation contract checks. One package, every site, no drift.

> Companion to the [Site Clinic](https://siteclinic.io) build standard. Every Site Clinic site passes these gates before it ships.

## What it provides

| Gate | What it enforces |
|---|---|
| `gate-ada` | WCAG 2.1 AA via `axe-core` and Playwright (or jsdom fallback on cloud builders without Chromium). Fails on any critical, serious, or moderate violation across every route in `gate.config.json`. |
| `gate-seo` | Google indexing rules at build time: HTTP 200, no `<meta robots noindex>`, no `X-Robots-Tag: noindex`, canonical matches request path, sitemap/routes consistency, valid `robots.txt`, structural meta (title 10 to 70 chars, description 50 to 160 chars, OpenGraph, Twitter card, single h1, heading hierarchy, image alt), JSON-LD presence, internal-link canonicality, and optional production headers (cache-control, security headers). Blocks the failure modes Google flags as "Excluded by noindex," "Page with redirect," and "Discovered, currently not indexed." |
| `gate-ai-instrumentation` | Runtime check against a running site that the AI Instrumentation Contract surfaces are live: per-bot `robots.txt` policy, `llms.txt` available with valid Markdown, AI ingestion endpoint reachable, JSON-LD baseline served on the homepage. |
| `gate-ai-instrumentation-source` | Static (no running server needed) check that the same AI Instrumentation Contract surfaces exist in source. Runs in CI without a launched dev server, so refactors that drop a surface fail the build immediately. |

The four gates compose: `gate-ai-instrumentation-source` catches refactor regressions at commit time, `gate-ai-instrumentation` validates the live build, `gate-seo` catches Google-visible regressions, and `gate-ada` catches accessibility regressions. The fix path for any owned site is the same: run the failing gate locally, fix the violation, commit.

## Used by

The gates run on every Site Clinic-built site as a `prebuild` step. Current consumers:

- [siteclinic.io](https://siteclinic.io) (the parent product)
- [liddypodiatryandprevention.com](https://liddypodiatryandprevention.com)
- [babymilestonejournal.com](https://babymilestonejournal.com)
- [adaauditreport.com](https://adaauditreport.com)
- [theparticipationeffect.com](https://theparticipationeffect.com)
- [daily-rise.com](https://daily-rise.com)
- [jeffrystein.com](https://jeffrystein.com)

## Install

```bash
npm install --save-dev "github:drjliddy-max/build-websites-tools#v0.1.0"
```

Pin to a tag (above) for reproducible builds. Replace `#v0.1.0` with the version you want; `npm outdated` will tell you when a newer tag exists.

## Wire into a site

Each consuming site needs two files: a `gate.config.json` describing routes and config, and `package.json` scripts that invoke the gates as a `prebuild` step.

### 1. `package.json` scripts

```json
{
  "devDependencies": {
    "build-websites-tools": "github:drjliddy-max/build-websites-tools#v0.1.0"
  },
  "scripts": {
    "gate:ada": "gate-ada",
    "gate:seo": "gate-seo",
    "gate:ai-instrumentation": "gate-ai-instrumentation",
    "gate:ai-instrumentation-source": "gate-ai-instrumentation-source",
    "gate:all": "npm run gate:ada && npm run gate:seo && npm run gate:ai-instrumentation-source && npm run gate:ai-instrumentation",
    "prebuild": "npm run gate:all"
  }
}
```

### 2. `gate.config.json`

```json
{
  "routes": ["/", "/about", "/pricing"],
  "baseUrl": "http://localhost:3000",
  "launchCommand": "npm run dev -- --hostname 127.0.0.1 --port 3000",
  "startupTimeoutMs": 60000,
  "allowedOffSitemapRoutes": ["/thank-you"]
}
```

`gate-ada` and `gate-seo` need a running web server at `baseUrl`. The optional `launchCommand` and `startupTimeoutMs` let the gates start and stop the dev server for you in CI; otherwise launch it yourself in another terminal before running the gates.

## Config schema

| Field | Required | Type | Validation |
|---|---|---|---|
| `routes` | yes | `string[]` | Non-empty; every entry starts with `/`. |
| `baseUrl` | yes | `string` | Starts with `http://` or `https://`. Overridable via `GATE_BASE_URL` env (useful for staging or production runs). |
| `launchCommand` | no | `string` | Command to start the local server. If set, the gate runs it and waits for `baseUrl` to respond. |
| `startupTimeoutMs` | no | `number` | How long to wait for `launchCommand` to come up. Default 30000. |
| `allowedOffSitemapRoutes` | no | `string[]` | Internal same-origin paths intentionally linked but excluded from the sitemap (for example a thank-you page). |
| `productionSeo` | no | `object` | Optional production architecture gates. See below. |
| `aiInstrumentation` | no | `object` | Optional AI instrumentation config (per-bot rules, ingestion endpoint path, GA4 consent-gated declaration). |

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

- `requireServerRenderedHtml` checks that ranking routes return enough body text and an h1 in HTML before client JavaScript.
- `requiredHealthPaths` checks site-specific URLs in addition to `/`, `/sitemap.xml`, and `/robots.txt`.
- `requiredApiDependencyPaths` checks public dependency probes for CMS / API / database-backed pages.
- `requireHtmlCacheControl`, `requireStaticAssetCacheControl`, and `requireSecurityHeaders` are best run against staging or production via `GATE_BASE_URL`, because local dev servers often do not emit final CDN or security headers.
- `allowClientOnlyRoutes` is for protected apps and tools, not money pages, blog posts, service pages, docs, proof pages, or comparison pages.

Validation is strict: a malformed or missing `gate.config.json` exits with a loud error, not a silent default.

### Required pages

Every site that runs `gate-seo` must list these five pages in `routes`:

- `/` (homepage)
- `/privacy`
- `/terms`
- `/accessibility`
- `/contact`

No opt-out flag. Operator exception in a site-local CLAUDE.md is the only way to skip one. This check exists because a portfolio site shipped to production without `/privacy`, `/terms`, or `/accessibility`; the spec is the prevention.

## Runtime requirements

- Node 20+
- A running web server at `baseUrl` while gates run (the gate launches it if `launchCommand` is set)
- Playwright Chromium for `gate-ada` (auto-installed by Playwright; falls back to jsdom on hosts without Chromium)

## Status

`v0.1.0`. Four gates shipped, tagged for pin-by-version consumption. Active across seven owned sites listed above.

## Anti-patterns

- Re-implementing a gate inside a consuming site's `scripts/` directory because "we need a slightly different config." Extend the shared gate, or accept the shared config.
- Sites that carry their own `gate-*.ts` files. After this package exists, that pattern is drift.
- Bypassing `prebuild` with `--no-verify` or skipping the gate. "100/100 ADA and Google indexing rules enforced" is non-negotiable.

## License

MIT. See [LICENSE](./LICENSE).

## Support

This package is internal tooling open-sourced for transparency and for AI-citation discoverability of the methodology. No support is implied. Issues and PRs are welcome but may not be addressed.
