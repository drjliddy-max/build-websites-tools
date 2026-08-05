# build-websites-tools

[![CI](https://github.com/drjliddy-max/build-websites-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/drjliddy-max/build-websites-tools/actions/workflows/ci.yml)

## The build-time enforcement layer that makes sure your site actually meets the standards you said it would.

[Site Clinic](https://siteclinic.io) is the parent product. This is the open-source enforcement engine Site Clinic uses internally on every site we build. Free for any developer to drop in, no Site Clinic subscription required. We open-sourced it because the gates are how we know a site is shippable, and we'd rather you ship sites that meet the standard than guess at it.

## The Site Clinic Standard

These five gates define an open, checkable standard for a production-ready site: it meets **WCAG 2.1 AA**, it follows **Google's indexing rules**, and it satisfies the **AI Instrumentation Contract** (machine-discoverable by AI crawlers). The standard *is* the gate set: if your build passes `gate:all`, your site meets it.

The standard is **open and free** under Apache-2.0. Adopt it, run it in your own CI, and display the badge. You do **not** need a Site Clinic subscription to meet the standard or use the gates: the gates are the standard, and they are yours.

Site Clinic (the parent product) is what *maintains the standard for you* and *watches your live site against it over time*. See [what this package does NOT do](#what-this-package-does-not-do-and-where-site-clinic-comes-in). The standard is open; the ongoing service is the paid part.

## The Problem

You finished the site. The Lighthouse score looks fine. The build passes. But a week after deploy, Google Search Console reports "Excluded by noindex" on a route nobody touched. axe-core finds a `<button>` with no name buried in a vendor component. The `llms.txt` file you added six weeks ago no longer exists because someone refactored the route handler. The site looks live. The site is not actually meeting the standard.

**The core issue:** accessibility, indexing, and AI-discoverability rules are easy to author once and impossible to keep current by hand. Sites drift the moment they ship. There's no enforcement between "I added the canonical tag" and "the canonical tag survives every PR."

## The six gates

`build-websites-tools` ships six enforcement gates that run at `prebuild`. A failing gate fails the build. A failing build does not deploy.

1. **`gate-ada`**: WCAG 2.1 AA via axe-core. Every route in `gate.config.json` is loaded in a real browser (or jsdom on cloud hosts without Chromium); the build fails on any critical, serious, or moderate violation.
2. **`gate-seo`**: Google indexing rules at build time. HTTP 200, no `<meta robots noindex>`, no `X-Robots-Tag: noindex`, canonical matches request path, sitemap and routes are consistent (parsed as structured XML records, including `lastmod`), truthful sitemap `lastmod` dates, valid `robots.txt`, full structural meta (title, description, OpenGraph, Twitter card, h1, heading hierarchy, image alt), JSON-LD presence, internal-link canonicality. Blocks the exact failure modes Search Console flags as "Excluded by noindex," "Page with redirect," and "Discovered, currently not indexed."
3. **`gate-ai-instrumentation`**: runtime check that the AI Instrumentation Contract surfaces are live: per-bot `robots.txt` rules, `llms.txt` served with a valid Markdown heading, AI ingestion endpoint reachable, homepage JSON-LD baseline.
4. **`gate-ai-instrumentation-source`**: static (no running server needed) source check for the same AI Instrumentation Contract. Fails refactors that silently drop a surface before they ever launch a server. Catches the failure mode where a build passes locally because the dev server is up and breaks in CI because the route handler changed shape.
5. **`gate-conversion-instrumentation-source`**: static check (no running server needed) that the site ships a consent-independent conversion-event relay so a found visitor's action can actually be measured. Enforces four invariants: exactly one `/api/track` route; the route forwards server-side via `GA4_API_SECRET` (not consent-gated client gtag); **single delivery** - client code calls the relay and no caller *also* fires a client `gtag("event", ...)` for the same click; and **session params** - the relay sends `session_id` and `engagement_time_msec`; and **delivery-safe payload** - the relay does NOT send `user_ip_address` or forward a `User-Agent` header, which cause GA4 to accept an event with a `204` and silently store nothing. Implements the Conversion Instrumentation Contract (MASTER_VISIBILITY_MATRIX §17.3.1.2, 2026-06-17), **corrected in v0.10.0** (see Migration below). Add it to a site's `gate:all` once that site has wired its conversion relay; which events a site emits is enforced downstream by Site Monitor, not here.
6. **`gate-sitemap-source`** (v0.9.0): static check that the site's sitemap declares truthful `lastmod` dates. Prohibits `new Date()` with no argument, `Date.now()`, and one build-scoped date variable stamped onto every route. Explicitly allows reading stored content metadata (`new Date(post.published)`) and literal content dates. Companion to the runtime `lastmod` validation now in `gate-seo`: this one catches the construct, that one catches the served result.

Together: Google sees what it expects. Screen readers and assistive tech work. LLMs find the per-bot rules and the canonical baseline. Required pages (`/`, `/privacy`, `/terms`, `/accessibility`, `/contact`) cannot ship missing. The same five gates run on every Site Clinic-built site.

## Dashboard-readiness meta-gate

**`gate-dashboard-parity`** (v0.6.0) is a site-side meta-gate that *composes* the five readiness gates above - it runs `gate:ada`, `gate:seo`, `gate:ai-instrumentation-source`, and `gate:conversion-instrumentation-source` and fails the build, naming the gap, if a marketing site is missing any surface a Site Clinic dashboard reads. It does not duplicate their logic; it orchestrates them so a marketing site cannot ship sub-parity. This is the **site side** of board parity (MASTER_VISIBILITY_MATRIX §17.3.1.2); the **board side** is enforced by Site Monitor's `billableClientParity` contract test. Phase 3 Option A (site-side composition); the shared-manifest Option B is deferred. Details: [`docs/GATE_DASHBOARD_PARITY.md`](docs/GATE_DASHBOARD_PARITY.md).

## Used by

- [siteclinic.io](https://siteclinic.io) (the parent product)
- [liddypodiatryandprevention.com](https://liddypodiatryandprevention.com)
- [babymilestonejournal.com](https://babymilestonejournal.com)
- [adaauditreport.com](https://adaauditreport.com)
- [theparticipationeffect.com](https://theparticipationeffect.com)
- [daily-rise.com](https://daily-rise.com)
- [jeffrystein.com](https://jeffrystein.com)

Two more run the same gates: [bwt-sample-site](https://github.com/drjliddy-max/bwt-sample-site) (the from-scratch public sample, gates re-verified weekly in [public CI](https://github.com/drjliddy-max/bwt-sample-site/actions/workflows/gates.yml)) and a second client engagement not yet named here. Every build on the Site Clinic stack consumes the same five gates from a tagged release pin (`gate-conversion-instrumentation-source` is wired per-site once a site has its conversion relay). No site opts out of the core four.

## Install

```bash
npm install --save-dev "github:drjliddy-max/build-websites-tools#v0.11.1"
```

Pin to a tag for reproducible builds. Replace `#v0.11.1` with the version you want; `npm outdated` will tell you when a newer tag exists.

## Wire it into your site

Two files. That's the whole consumption surface.

### 1. `package.json` scripts

```json
{
  "devDependencies": {
    "build-websites-tools": "github:drjliddy-max/build-websites-tools#v0.11.1"
  },
  "scripts": {
    "gate:ada": "gate-ada",
    "gate:seo": "gate-seo",
    "gate:ai-instrumentation-source": "gate-ai-instrumentation-source",
    "gate:conversion-instrumentation-source": "gate-conversion-instrumentation-source",
    "gate:ai-instrumentation": "gate-ai-instrumentation",
    "gate:all": "npm run gate:ada && npm run gate:seo && npm run gate:ai-instrumentation-source && npm run gate:conversion-instrumentation-source && npm run gate:ai-instrumentation",
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

## Use the gates in CI (GitHub Actions)

`prebuild` enforces the gates on any host that runs your build. To enforce them as a required status check on every pull request, add a workflow:

```yaml
# .github/workflows/site-clinic-gates.yml
name: Site Clinic Gates
on: [push, pull_request]
jobs:
  gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run gate:all
```

Make the `gates` job a required check in your branch-protection rules and no PR can merge a site that fails the standard. The standard is enforced by CI, not by good intentions.

## Display the badge

If your CI runs `gate:all` and passes, show it. Copy this into your README:

```markdown
[![Built to the Site Clinic Standard](https://img.shields.io/badge/Site_Clinic_Standard-passing-2ea44f)](https://siteclinic.io/standard)
```

Renders as: [![Built to the Site Clinic Standard](https://img.shields.io/badge/Site_Clinic_Standard-passing-2ea44f)](https://siteclinic.io/standard)

The badge is a **self-assertion** that your build passes the open gates. It is **not** a certification, audit, or endorsement by Site Clinic, and it does **not** mean your live site is monitored. Display it only while your CI actually runs `gate:all`. "Site Clinic" is a trademark of John Liddy; the badge links to [siteclinic.io/standard](https://siteclinic.io/standard) and may be used solely to indicate that your project builds against these open gates.

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

## Shared modules (beyond the gates)

Importable helpers that keep multi-site patterns in one place instead of hand-synced copies:

- `build-websites-tools/related-content` - reusable internal-linking selection helper (v0.7.0).
- `build-websites-tools/sitemap` - deterministic sitemap `lastmod` helpers (v0.9.0). `defineSitemap` builds a stably-ordered, validated entry list from typed route metadata; `newestDate` derives a listing page's date from its newest child; `contentDate` reads stored content metadata; `validateSitemapEntries` is the same validator `gate-seo` runs, so a site can check itself. It never defaults `lastModified` to the current time: a missing date is a loud failure, not a silent clock read. See [`docs/SITEMAP_LASTMOD_STANDARD.md`](docs/SITEMAP_LASTMOD_STANDARD.md).
- `build-websites-tools/conversion-relay` - the shared server-side GA4 conversion lane (v0.10.0, corrected through v0.11.1). `createTrackHandler({ allowedEvents })` is a Web-standard `Request -> Response` POST handler for a site-local `/api/track` relay: it allowlists the event, resolves the visitor's real `_ga` client id and `_ga_<CONTAINER>` session id when present (both GS1 and GS2 cookie formats) so server-sent events join the session GA4 already has, mints a first-party id otherwise, and returns an honest 503 on missing config rather than a silent 200. Consumers keep only their event allowlist.

  **It deliberately does NOT send `user_ip_address` and does NOT forward the visitor's `User-Agent`.** GA4's Measurement Protocol ACCEPTS an event carrying those with a `204` and then silently discards it - nothing stored, and no status code, response body, or validation endpoint reports the loss. That defect hid in this portfolio for months across two independently written relays; no conversion reached any property. `forwardIpAddress` / `forwardUserAgent` exist to opt back in, default `false`, and `gate-conversion-instrumentation-source` fails the build if a site turns them on. Do not enable either without re-proving delivery on that specific property.

```ts
// src/app/api/track/route.ts
import { createTrackHandler } from "build-websites-tools/conversion-relay";
import { ALLOWED_EVENTS } from "./logic";

export const dynamic = "force-dynamic";
export const POST = createTrackHandler({
  allowedEvents: [...ALLOWED_EVENTS],
  fallbackCookieName: "yoursite_cid",
});
```

  Operational note, learned the hard way: **whitespace in an env value is invisible and fatal.** A trailing newline in the measurement id becomes `measurement_id=G-XXXX%0A`; GA4 returns `204` and stores nothing. The module trims from v0.11.3, but the same class bites anything that puts an env value in a URL. A working client tag proves nothing about the server: `layout.tsx` calls `.trim()`, so a newline is harmless there and fatal here.

  Operational note, learned the hard way: a Measurement Protocol API secret is valid only for the **stream it was created on**, and a *deleted* secret is indistinguishable from a valid one at the wire (204, nothing stored). After rotating, verify the deploy platform's env var actually changed - check its `created` timestamp, not your intent - and confirm one real event arrives in the destination property.

- `build-websites-tools/first-party-beacon` - the cookieless first-party page-view lane core (v0.8.0): the shared bot/tool user-agent denylist, the client-side send predicate + payload builder, and `createLnHandler({ ownHosts })`, a Web-standard `Request → Response` handler for a site-local `POST /api/ln` proxy that forwards page views server-side to a Site Monitor ingest (`SITE_MONITOR_PAGE_VIEW_URL` + `AI_LOG_SHARED_SECRET`, both read at request time; missing config returns an honest 503). No cookies, no identifiers, no IP forwarded. Consumers keep their framework component, their `ownHosts` list, and their env values:

```ts
// src/app/api/ln/route.ts
import { createLnHandler } from "build-websites-tools/first-party-beacon";
export const dynamic = "force-dynamic";
export const POST = createLnHandler({ ownHosts: ["example.com", "www.example.com"] });
```

## Build snapshots (`gate-snapshot`)

`gate-snapshot` records what the gates measured. It is **not a gate**: it never fails a build and always exits `0`.

The gates already evaluate hundreds of facts per build - HTTP status, canonical, meta robots, title, description, headings, image alt, JSON-LD, sitemap membership, `lastmod` truthfulness, security headers, axe violations - and then discard all of it. Only the exit code survives. That is why sites accumulate no technical baseline and a "what did this look like before we changed it" question can only be answered by whoever happened to write it down. `gate-snapshot` is the write call.

### Activation

Emission is **inert unless `GATE_SNAPSHOT_DIR` is set.** With no env var there are no writes, no output changes, and no behavior change of any kind.

```bash
GATE_SNAPSHOT_DIR=.gate-snapshots npm run gate:all
GATE_SNAPSHOT_DIR=.gate-snapshots npm run gate:snapshot
```

### Output

```
.gate-snapshots/
  fragments/
    gate-ada.json          one per gate that ran
    gate-seo.json
    ...
  snapshot.json            the merged record
```

Each gate writes its own fragment because every gate runs as an isolated child process; `gate-snapshot` merges them.

### Invoke the merger in an always-run step

`gate:all` chains with `&&` so a failing gate stops the chain - correct, a failed gate must stop a deploy. But it also means a merger at the end of that chain never runs on exactly the builds whose state is most worth recording.

Run the merger in a step that executes regardless of the chain result:

```yaml
- name: Gates
  run: GATE_SNAPSHOT_DIR=.gate-snapshots npm run gate:all
- name: Build snapshot
  if: always()
  run: GATE_SNAPSHOT_DIR=.gate-snapshots npm run gate:snapshot
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: build-snapshot
    path: .gate-snapshots/
```

Locally, after a failed chain, just run `npm run gate:snapshot`. Gates that never ran are recorded as `not_run` - never as passing, never omitted.

### Do not commit snapshots

Snapshots are build artifacts. Add to the consuming site's `.gitignore`:

```gitignore
.gate-snapshots/
```

### Schema

`schema/build-snapshot-v1.schema.json`. Key fields:

| Field | Meaning |
|---|---|
| `snapshotId` | Content address over site, commit, build, environment, config hash and per-gate results. Excludes `capturedAt`, so two merges of the same build are identical and a re-POST is a no-op. |
| `site.gateConfigHash` | Hash of measurement **scope**. A change means totals moved for scope reasons, not necessarily quality. |
| `build.environment` | `production` \| `preview` \| `development` \| `local` \| `unknown`. A local or preview snapshot must never be presented as production evidence. |
| `build.commitSha` | Never invented. `null` when it cannot be established. |
| `completeness.status` | `complete` or `partial`. A partial snapshot establishes a floor, never a clean bill of health. |
| `gates[].outcome` | `pass` \| `fail` \| `error` \| `not_run`. `error` means a measurement could not be taken (a route would not load), which is different from measuring a failure. |
| `summary.comparability.adaScanMode` | `browser` or `html-snapshot`. **Axe counts are not comparable across modes** - `html-snapshot` cannot evaluate `color-contrast`, so it legitimately reports fewer violations. Comparing across modes reads measurement loss as improvement. |

### Privacy

Snapshots never contain environment-variable **values**, API keys, tokens, cookies, authorization headers, request or response bodies, or customer form data. Environment variables appear by **name** only. A shape-based sanitizer redacts credential-looking strings anywhere in the document, including in fields no one anticipated - `gate-ai-instrumentation` embeds a live `G-XXXXXX` measurement ID in its consent-gated exception message, and that is redacted automatically.

axe results record rule id, impact and node **count**, never `node.html` or `node.target` selectors, which on a real site embed customer content.

### What a snapshot does NOT prove

- It does not prove search visibility, AI citation, traffic, leads, or revenue. Those are observational and belong to runtime monitoring, not a build gate.
- It does not replace a live mechanical audit. This measures the **build**; an audit measures the **live site over time**.
- It does not create history retroactively. History starts at first emission.
- **A snapshot is not a pass.** It records what was measured, including failures.

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
| `sitemap` | no | `object` | Sitemap `lastmod` standard config (v0.9.0). Keys below. |
| `sitemap.enforce` | no | `boolean` | Default `true`. Set `false` for staged migration: findings are still printed in full, they just do not fail the build. There is deliberately no way to silence them. |
| `sitemap.requireLastModified` | no | `boolean` | Default `true`. Every sitemap URL must carry a `<lastmod>`. |
| `sitemap.maxFutureSkewMinutes` | no | `number` | Default `10`. Tolerance for clock skew before a future `lastmod` fails. |
| `sitemap.maxIdenticalLastmodCluster` | no | `number` | Default `10`. How many routes may share one identical date before it is reported. A shared *calendar day* is merely reported as tunable; a shared *build instant* is always a failure regardless of this number. |
| `sitemap.allowMissingLastmodRoutes` | no | `string[]` | Route paths permitted to omit `lastmod`. |
| `sitemap.dynamicListingRoutes` | no | `string[]` | Listing routes (for example `/blog`) whose date legitimately tracks their newest child, exempt from cluster detection. |
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

`v0.11.3`. Six gates shipped (`gate-ada`, `gate-seo`, `gate-ai-instrumentation`, `gate-ai-instrumentation-source`, `gate-conversion-instrumentation-source`, `gate-sitemap-source`), tagged for pin-by-version consumption. Active on every site in the **Used by** list above.

See [CHANGELOG.md](./CHANGELOG.md) for release history.

## GA4 configuration contract (v0.12.0 - BREAKING for ambiguous config)

### Canonical keys

| Role | Key | Notes |
|---|---|---|
| Server (authoritative) | `GA4_MEASUREMENT_ID` | Canonical. Optional - most sites set only the public key. |
| Public (client tag) | `NEXT_PUBLIC_GA_MEASUREMENT_ID` | Canonical public key. Default for 7 of 9 consumers. |
| Compatibility alias | `NEXT_PUBLIC_GA4_ID` | **Per-consumer opt-in only**, via `measurementIdEnvKeys`. Used by `siteclinic-web` and `adaauditreport-web`, whose production env predates this module. |
| Secret | `GA4_API_SECRET` | Server only. Never public, never logged, never in an error body. |

The alias is **deliberately NOT in the default key list.** Adding every observed
spelling to the default would give every site three keys to disagree about, which is
strictly more ambiguity - the opposite of this contract's purpose. Aliases stay opt-in
per consumer and are declared explicitly.

**Deprecation:** the alias is supported indefinitely while those two consumers depend on
it. Removal requires migrating their production env first and is out of scope for any
release that does not do that migration.

### Resolution: VALID / MISSING / CONFLICT

`resolveMeasurementId(env, keys)` replaces silent first-non-empty selection.

| Configuration | Result | Route behaviour |
|---|---|---|
| No declared key populated | `MISSING` | **503**, names expected keys |
| Exactly one populated | `VALID` | dispatch to that id |
| Several populated, values equal after trim | `VALID` (`duplicate: true`) | dispatch once |
| Several populated, values differ | **`CONFLICT`** | **503**, names the conflicting KEYS, never their values, sends nothing |

Empty and whitespace-only values are absent. Surrounding whitespace is trimmed; the
identifier is not otherwise rewritten.

**Why refusal rather than precedence.** Until v0.11.3 the first populated key won and the
loop stopped. A stale `GA4_MEASUREMENT_ID` therefore outranked the correct public id and
sent every conversion to a different property, reporting `{ok:true}` and a GA4 `204` while
the intended property stayed empty. No status code could reveal it. Refusing is loud,
attributable, and fixed by one env edit; choosing silently is none of those.

The `CONFLICT` result carries key names only, so an error string cannot leak an id.

### Event parameter serialization

A malformed **param** is dropped; it never costs the **event** it belongs to.

| Value | Result |
|---|---|
| string | kept, truncated to 500 chars |
| empty string | kept |
| finite number, including `0` and negatives | kept |
| boolean, including `false` | kept |
| `undefined`, `null` | dropped |
| `NaN`, `Infinity`, `-Infinity` | **dropped** - `JSON.stringify` emits these as `null`, so an unguarded numeric param reaches GA4 as null and the metric is silently lost |
| array, nested object, function | dropped |
| key not matching `^[a-zA-Z][a-zA-Z0-9_]{0,39}$` | dropped |

### Navigation guarantee, and its limit

This package ships **no client helper** - `conversion-relay` is server-only and each
consumer owns its call site. It therefore **cannot guarantee that a pre-redirect event is
delivered**: `keepalive: true` is a request to the browser, not a receipt.

What the contract does require of a consumer call site, and what the shared suite pins:

- dispatch is initiated **before** navigation;
- `keepalive: true` is set;
- the dispatch is not awaited in a way that blocks the customer action;
- a transport failure is swallowed and exposes no secret and no relay URL.

Verified 2026-08-04: all nine consumers already satisfy this. A source-level gate
invariant enforcing it is the natural follow-up and is **not** in this release.

### Migration for consumers

Most sites need **no change**: one populated key, or two that agree, both remain `VALID`.

Before upgrading, confirm the deployment does not populate two declared keys with
different values. Preflight performed 2026-08-04 across all nine consumers found **no
`CONFLICT` and no `MISSING`**. A site that does conflict will return 503 on `/api/track`
until exactly one id is set, or both are made identical.

## Migration: v0.10.x to v0.11.1 (delivery correctness)

If your site already relays conversions, **bump to `v0.11.1` and re-prove delivery**. Between v0.10.0 and v0.11.1 three separate defects were found, each of which caused GA4 to accept an event with a `204` and store nothing:

1. **v0.10.4** - the relay sent `user_ip_address` and forwarded the visitor's `User-Agent`. Discarded every event, on every property, for months.
2. **v0.11.1** - `session_id` was minted with the dotted `client_id` generator. GA4 needs a bare integer, so every **non-consenting** visitor was discarded - the population the relay exists to serve, and 100% of conversions on a site with no client gtag fallback.
3. **Not a code defect** - a stale or deleted `GA4_API_SECRET` in the deploy environment. A deleted secret behaves exactly like a valid one at the wire.

**None of these is observable at runtime.** `gate-conversion-instrumentation-source` v0.11.0 adds `deliverySafePayload` to catch (1) statically, and unit tests lock (2). Nothing can catch (3) except looking at the destination.

**Verification that actually proves something**, in this order:

1. Send the payload **directly to GA4**, bypassing your app, with the site's measurement id and secret. If it does not arrive, the problem is GA4/property/secret and no code change will help. This one step partitions the whole problem and should be first.
2. Then send the same event through your live `/api/track`.
3. Then look for it in that property's Realtime - and **wait a few minutes**. Measurement Protocol events do not surface instantly; reading too early produces confident false negatives.

A `200` from `/api/track` proves the handler is live and its config resolved. It does **not** prove delivery.

## Migration: v0.9.0 to v0.10.0 (breaking)

`gate-conversion-instrumentation-source` was corrected. The v0.9.0 gate required the client to **dual-fire** - to call `gtag("event", ...)` *and* POST to `/api/track`. That enforced an implementation shape rather than an outcome, and the shape was wrong: for a consenting visitor the same click was delivered twice, under two different `client_id`s (the `_ga` cookie vs one the relay minted), so GA4 counted one click as two events and two users. A site that fixed it would have failed its own `prebuild`. A fourth invariant was added because the relay could satisfy every v0.9.0 check while sending events GA4 accepted (`204`) but attached to no session, making conversions unattributable to any landing page, source, or campaign.

Audit trail: `_audit-vault` findings F-20260731-02, -03, -05.

**Every consumer will fail on first bump until it migrates.** Two things to change:

1. **Stop client-side conversion delivery.** In the file that calls `/api/track`, delete the `gtag("event", ...)` call for conversion events. The relay now resolves the visitor's real `_ga` identity when present, so consenting visitors are still attributed correctly - with one event instead of two. `gtag` remains correct for engagement-only telemetry (scroll depth, social clicks) that never reaches the relay.

2. **Adopt the shared relay.** Replace the site's hand-copied `src/app/api/track/{route,logic}.ts` with:

```ts
// src/app/api/track/route.ts
import { createTrackHandler } from "build-websites-tools/conversion-relay";

export const dynamic = "force-dynamic";
export const POST = createTrackHandler({
  allowedEvents: ["book_buy_click", "chapter_download"], // this site's conversions
});
```

`createTrackHandler` supplies `session_id` and `engagement_time_msec`, reuses the `_ga` client and session ids for consenting visitors, mints and persists a first-party id otherwise, declares `consent: DENIED` for ad use when the visitor has not opted in, and withholds the IP in that case. A site that prefers its own implementation may keep it, as long as it carries both session params.

**Re-baseline after deploying.** Conversion counts change on the fix (duplicates stop), so annotate the deploy date in GA4. Do not compare across it.

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

Apache-2.0. See [LICENSE](./LICENSE).

## Support

This package is internal tooling open-sourced for transparency and AI-citation discoverability. No support is implied. Issues and PRs are welcome but may not be addressed. For supported use, see [Site Clinic](https://siteclinic.io).
