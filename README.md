# build-websites-tools

[![CI](https://github.com/drjliddy-max/build-websites-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/drjliddy-max/build-websites-tools/actions/workflows/ci.yml)

## The build-time enforcement layer that makes sure your site actually meets the standards you said it would.

[Site Clinic](https://siteclinic.io) is the parent product. This is the open-source enforcement engine Site Clinic uses internally on every site we build. Free for any developer to drop in, no Site Clinic subscription required. We open-sourced it because the gates are how we know a site is shippable, and we'd rather you ship sites that meet the standard than guess at it.

## The Problem

You finished the site. The Lighthouse score looks fine. The build passes. But a week after deploy, Google Search Console reports "Excluded by noindex" on a route nobody touched. axe-core finds a `<button>` with no name buried in a vendor component. The `llms.txt` file you added six weeks ago no longer exists because someone refactored the route handler. The site looks live. The site is not actually meeting the standard.

**The core issue:** accessibility, indexing, and AI-discoverability rules are easy to author once and impossible to keep current by hand. Sites drift the moment they ship. There's no enforcement between "I added the canonical tag" and "the canonical tag survives every PR."

## The four gates

`build-websites-tools` ships four enforcement gates that run at `prebuild`. A failing gate fails the build. A failing build does not deploy.

1. **`gate-ada`**: WCAG 2.1 AA via axe-core. Every route in `gate.config.json` is loaded in a real browser (or jsdom on cloud hosts without Chromium); the build fails on any critical, serious, or moderate violation.
2. **`gate-seo`**: Google indexing rules at build time. HTTP 200, no `<meta robots noindex>`, no `X-Robots-Tag: noindex`, canonical matches request path, sitemap and routes are consistent, valid `robots.txt`, full structural meta (title, description, OpenGraph, Twitter card, h1, heading hierarchy, image alt), JSON-LD presence, internal-link canonicality. Blocks the exact failure modes Search Console flags as "Excluded by noindex," "Page with redirect," and "Discovered, currently not indexed."
3. **`gate-ai-instrumentation`**: runtime check that the AI Instrumentation Contract surfaces are live: per-bot `robots.txt` rules, `llms.txt` served with a valid Markdown heading, AI ingestion endpoint reachable, homepage JSON-LD baseline.
4. **`gate-ai-instrumentation-source`**: static (no running server needed) source check for the same AI Instrumentation Contract. Fails refactors that silently drop a surface before they ever launch a server. Catches the failure mode where a build passes locally because the dev server is up and breaks in CI because the route handler changed shape.

Together: Google sees what it expects. Screen readers and assistive tech work. LLMs find the per-bot rules and the canonical baseline. Required pages (`/`, `/privacy`, `/terms`, `/accessibility`, `/contact`) cannot ship missing. The same four gates run on every Site Clinic-built site.

## Used by

- [siteclinic.io](https://siteclinic.io) (the parent product)
- [liddypodiatryandprevention.com](https://liddypodiatryandprevention.com)
- [babymilestonejournal.com](https://babymilestonejournal.com)
- [adaauditreport.com](https://adaauditreport.com)
- [theparticipationeffect.com](https://theparticipationeffect.com)
- [daily-rise.com](https://daily-rise.com)
- [jeffrystein.com](https://jeffrystein.com)

## Install

```bash
npm install --save-dev "github:drjliddy-max/build-websites-tools#v0.3.1"
```

Pin to a tag for reproducible builds. Replace `#v0.3.1` with the version you want; `npm outdated` will tell you when a newer tag exists.

## Wire it into your site

Two files. That's the whole consumption surface.

### 1. `package.json` scripts

```json
{
  "devDependencies": {
    "build-websites-tools": "github:drjliddy-max/build-websites-tools#v0.3.1"
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

Start from one of the [templates](./templates/) and adjust:

- `templates/marketing-site.json` for a near-static marketing site
- `templates/blog.json` for marketing + a content blog
- `templates/app-with-protected-routes.json` for a site with an authenticated app section

Schema, validation rules, and the full list of optional production-architecture gates are documented in this README's [Config schema](#config-schema) section below, and copyable from the templates.

That's it. No gate logic in your repo. No copy-pasted scripts. No drift surface.

## Common pitfalls

Three things a fresh consumer reliably hits on the first integration. None is a tooling defect; all three are easy once you know they exist.

### `canonical link` fails locally with `http://...`

`gate:seo` enforces `https://` on every canonical href, by design. Production canonicals must point at the deployed origin. The shipped marketing-site template defaults `baseUrl: "http://127.0.0.1:3000"`, and Next.js will inherit that as `metadataBase` if you do not override it.

Fix: set `metadataBase` (or the framework equivalent) to your eventual deploy URL even in dev. The gate does not follow the URL. It checks the rendered string. Example for Next.js App Router:

```tsx
// src/app/layout.tsx
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://example.com"),
  alternates: { canonical: "/" },
};
```

### `og:type` missing on child pages (Next.js)

Next.js metadata merging **replaces** the parent's `openGraph` object when a child sets its own. It does not field-merge. A root layout that declares `openGraph.type: "website"` does not pass through to any page that exports its own `openGraph`.

Fix: either set the entire `openGraph` block at the root only, or include `type: "website"` (or the applicable type) explicitly on every page that overrides `openGraph`:

```tsx
export const metadata: Metadata = {
  openGraph: { type: "website", url: "/about", title: "About" },
};
```

### No analytics? Opt out of the GA4 check

The `aiInstrumentation` runtime gate requires a GA4 measurement ID in the served homepage HTML by default: either an inline `gtag('config', 'G-…')` call or a `googletagmanager.com/gtag/js?id=G-…` loader script. This is correct for the matrix doctrine, but blocks sites that deliberately ship no analytics.

Fix: declare the opt-out in `gate.config.json`. The gate will record it as a declared exception:

```json
{
  "aiInstrumentation": {
    "checks": { "ga4": false }
  }
}
```

For consent-gated GA4 (the script injects only after a user consent action), declare the measurement ID instead. The gate replaces the failed `ga4` check with a passing "consent-gated declared exception" line:

```json
{
  "aiInstrumentation": {
    "ga4": { "consentGated": { "measurementId": "G-XXXXXXXX" } }
  }
}
```

For a working end-to-end sample that exercises all of the above against a fresh Next.js 16 build, see [bwt-sample-site](https://github.com/drjliddy-max/bwt-sample-site) (live at [bwt-sample-site.vercel.app](https://bwt-sample-site.vercel.app)).

## What this package does NOT do (and where Site Clinic comes in)

`build-websites-tools` is build-time enforcement. It runs once per deploy, fails the build if something's wrong, and exits. That's the whole job.

What it does NOT do:

- Watch your live site after deploy and tell you when something regressed in production.
- Aggregate accessibility / SEO / AI-citation data across multiple sites you own.
- Alert you when Search Console flags a new exclusion or when an AI bot stops citing you.
- Pre-wire a brand-new site with the gates, monitoring, dashboards, and the doctrine docs in one move.
- Provide audit-grade reports a client or attorney can read.

That's what [Site Clinic](https://siteclinic.io) does. The gates are free; the ongoing surface (runtime monitoring, AI visibility tracking, audit reports, pre-wired site builds) is the paid service. Use the gates standalone if you want the enforcement and nothing else. Subscribe to Site Clinic if you want the gates wired in for you, plus a dashboard that tells you when production drifts away from what the gates verified at build time.

## Config schema

| Field | Required | Type | Validation |
|---|---|---|---|
| `routes` | yes | `string[]` | Non-empty; every entry starts with `/`. |
| `baseUrl` | yes | `string` | Starts with `http://` or `https://`. Overridable via `GATE_BASE_URL` env (useful for running gates against staging or production from CI). |
| `launchCommand` | no | `string` | Command to start the local server. If set, the gate runs it and waits for `baseUrl` to respond. |
| `startupTimeoutMs` | no | `number` | How long to wait for `launchCommand` to come up. Default 30000. |
| `allowedOffSitemapRoutes` | no | `string[]` | Internal same-origin paths intentionally linked but excluded from the sitemap (for example a thank-you page). |
| `productionSeo` | no | `object` | Optional production architecture gates (server-rendered HTML, health paths, cache, security headers). |
| `aiInstrumentation` | no | `object` | Optional AI instrumentation config (per-bot rules, ingestion endpoint path, GA4 consent-gated declaration). |
| `aiInstrumentation.checks` | no | `object` | Per-dimension opt-outs. Keys: `ga4`, `llmsTxt`, `robotsAiPolicy`, `jsonLd`. Set a key to `false` to skip the named check. Surfaces in the gate output as a declared exception rather than a silent skip. Use for sites that deliberately ship no analytics, or that serve one of the AI Instrumentation Contract surfaces under a different mechanism the gate cannot detect. |
| `aiInstrumentation.skip` | no | `{ reason: string }` | Whole-gate opt-out with a documented reason. Surfaces in the §19 scorecard as an accepted exception. Use sparingly. The matrix doctrine prefers per-check opt-outs over whole-gate skips. |

### Required pages

Every site that runs `gate-seo` must list these five routes in `gate.config.json`:

`/`, `/privacy`, `/terms`, `/accessibility`, `/contact`

No opt-out flag. The check is enforced because a portfolio site previously shipped without `/privacy`, `/terms`, or `/accessibility` and the gate exists specifically to prevent recurrence.

## Documentation

- [AGENTS.md](./AGENTS.md): standardized agent-onboarding playbook (Claude Code, Codex, Cursor, Aider). Tells any AI agent how to wire the gates into a new or existing site.
- [CLAUDE.md](./CLAUDE.md): Claude-Code-specific notes for contributors to this repo.
- [llms.txt](./llms.txt): AI ingestion summary at the repo root.
- [templates/](./templates/): copyable `gate.config.json` shapes per site type.

## Status

`v0.3.1`. Four gates shipped, tagged for pin-by-version consumption. Active on every site in the **Used by** list above.

See [CHANGELOG.md](./CHANGELOG.md) for release history.

## Anti-patterns

- Re-implementing a gate inside a consuming site's `scripts/` directory because "we need a slightly different config." Extend the shared gate, or accept the shared config.
- Sites that carry their own `gate-*.ts` files. After this package exists, that pattern is drift.
- Bypassing `prebuild` with `--no-verify` or skipping the gate. "100/100 ADA and Google indexing rules enforced" is non-negotiable for sites Site Clinic ships.

## Created by John Liddy

This package is the QA enforcement layer of [Site Clinic](https://siteclinic.io). Site Clinic builds and monitors websites that meet WCAG 2.1 AA, Google indexing rules, and the AI Instrumentation Contract on day one and every day after.

Free things from Site Clinic:

- This repo (the build-time gates)
- The [Site Clinic blog](https://siteclinic.io/blog) on AI visibility, accessibility, and indexing
- The [ADA Audit Report](https://adaauditreport.com) tool

Paid things from Site Clinic:

- Site Clinic subscription: ongoing monitoring, AI-citation tracking, audit reports, alert when gates regress in production
- Pre-wired site builds: a new site shipped with the gates, monitoring, and the brand layer wired in
- Full ADA Audit Report deliverables

## License

MIT. See [LICENSE](./LICENSE).

## Support

This package is internal tooling open-sourced for transparency and AI-citation discoverability. No support is implied. Issues and PRs are welcome but may not be addressed. For supported use, see [Site Clinic](https://siteclinic.io).
