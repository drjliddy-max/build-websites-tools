# Changelog

Get notified of major releases by subscribing at [siteclinic.io](https://siteclinic.io).

## [Unreleased]

- `ci`: public GitHub Actions workflow (`.github/workflows/ci.yml`) running typecheck + the full detection-pattern test suite on every push and PR, with a README badge. The test-suite claim is now continuously reproduced in public, per the trust-stack reproducibility rule. Companion workflow on [bwt-sample-site](https://github.com/drjliddy-max/bwt-sample-site) runs all five gates end to end weekly and on push.
- `docs`: GitHub Releases published for every tag v0.2.0 through v0.4.1, notes sourced from this changelog.

## [0.11.2] - 2026-08-03

Docs only. No source change; `npm test` 197/197 and typecheck unchanged from v0.11.1.

- `docs`: install examples corrected from `#v0.5.2` to the current tag. They were six minor versions stale, so a new consumer following the README would have wired a version carrying every delivery defect fixed since - the `user_ip_address`/`User-Agent` silent discard and the dotted `session_id`.
- `docs`: `conversion-relay` documented under Shared modules with its adoption snippet, why `forwardIpAddress`/`forwardUserAgent` are off by default, and the fact that a Measurement Protocol secret is valid only for the stream it was created on while a deleted secret is indistinguishable from a valid one at the wire.
- `docs`: v0.10.x to v0.11.1 migration section giving the verification order that actually proves delivery - direct-to-GA4 first, since it partitions GA4/secret from your own code in one step.
- Released as its own tag because the docs correction landed after the `v0.11.1` tag, leaving `main` and that tag both claiming 0.11.1 while differing. Consumers on `v0.11.1` need no bump: the shipped code is byte-identical.

## [0.11.1] - 2026-08-03

- `fix(conversion-relay)`: mint `session_id` as a **bare integer**, separate from `client_id`. WHY: GA4 wants two different shapes - `client_id` is dotted `"<random>.<epoch>"` mirroring the `_ga` cookie, `session_id` is a plain integer. One generator was used for both. A CONSENTING visitor was unaffected, because their `session_id` is read from `_ga_<CONTAINER>` and is already an integer - which is exactly why the 2026-08-01 end-to-end proof passed. A NON-consenting visitor got a dotted `session_id`, and GA4 returned 204 and discarded the event. Proven 2026-08-03: the same production relay that delivers for a consented click delivered nothing for a cookieless request. That is the entire population the relay exists to serve, and on `adaauditreport-web` - which has no client gtag fallback - it is 100% of conversions.
- `feat(conversion-relay)`: `generateSessionId` option, defaulting to epoch seconds.
- `test`: regression test asserting a minted `session_id` matches `/^\d+$/` while `client_id` keeps the dotted form.

## [0.11.0] - 2026-08-01

- `feat(gate-conversion-instrumentation-source)`: fifth invariant **`deliverySafePayload`**. Fails the build when the `/api/track` implementation sends `user_ip_address`, forwards a `"User-Agent"` header to the collect endpoint, or opts back in via `forwardIpAddress`/`forwardUserAgent: true`. WHY: every one of the previous four invariants passed on all nine sites while GA4 discarded 100% of the events (v0.10.4). This is the only invariant in the gate that exists because of a defect **no runtime signal could reveal** - the wire response for a discarded event is byte-identical to the response for a stored one, so source is the only place it is visible. Comments are stripped before matching, so documenting the prohibited fields is not itself a violation. Per-site escape hatch: `conversionInstrumentation.source.checks.deliverySafePayload: false`.
- `test`: 4 tests, verified RED against the exact relay shape that was live on all nine sites on the morning of 2026-08-01.

## [0.10.4] - 2026-08-01

**This is the release that makes the relay actually deliver. Every consumer should bump.**

- `fix(conversion-relay)`: stop sending `user_ip_address` and stop forwarding the visitor's `User-Agent` by default. Both are now opt-in (`forwardIpAddress`, `forwardUserAgent`), default `false`. WHY: GA4 returned `204` for every server-relayed conversion and silently discarded it. Proven 2026-08-01 by sending a byte-identical payload by hand from a laptop to the same `measurement_id` with the same `api_secret` - it appeared in Realtime within seconds. The only difference was these two extras. Both were present in the pre-2026-07-31 implementation as well, which is why **no conversion event has ever reached any property in this portfolio** - the ADA funnel built 2026-06-19 has never recorded a single data point. The failure mode is a silent `204`, so no runtime check, status code, or gate could ever have caught it; only an end-to-end delivery test could.
- **Cost of the fix**: with no `user_ip_address`, GA4 derives geo from the sender - the serverless region - so server-relayed conversions carry the function's location, not the visitor's. An attributable conversion with wrong geo beats a correctly-geolocated conversion that does not exist. Re-enable per consumer only after re-proving delivery on that property.
- `test`: 2 regression tests lock the default off, plus 2 covering the opt-in path. One pre-existing test asserted `user_ip_address` WAS forwarded - it had locked in the defect - and was corrected with a note.

## [0.10.3] - 2026-07-31

- `feat(conversion-relay)`: `createTrackHandler` accepts `measurementIdEnvKeys`, the env var names to read the GA4 measurement id from, in order. Default `["GA4_MEASUREMENT_ID", "NEXT_PUBLIC_GA_MEASUREMENT_ID"]` - unchanged behaviour for consumers that do not pass it. WHY: consumers predate this module and resolve the id from their own names; `adaauditreport-web` uses `GA4_MEASUREMENT_ID || NEXT_PUBLIC_GA4_ID`. Hardcoding two names would have 503'd that site's relay on a live revenue path if only the site-specific name were set on the project. Renaming env vars across nine production projects to suit a shared module is the riskier direction, so the module accommodates the consumer. Undeclared names are still never probed: an id present only under an unlisted key fails closed with 503, and the 503 message now names the keys actually checked.
- `test`: 2 tests - a declared site-specific key resolves and reaches the Measurement Protocol URL, and an undeclared key still 503s.

## [0.10.2] - 2026-07-31

- `fix(gate-conversion-instrumentation-source)`: `singleDelivery` no longer fires on a `gtag("event", ...)` that appears only in a COMMENT. WHY: the corrected `TrackedLink.tsx` on participation-effect-site explains in a comment that it "used to also call `window.gtag('event', ...)`", and the gate failed on its own remediation note. A gate that punishes the explanation of a fix teaches people to delete the explanation. `gate-sitemap-source` already applied this rule; this gate now reuses its helper rather than reimplementing it.
- `feat(gate-sitemap-source)`: `stripCommentsAndStrings` takes an optional `{ strings?: boolean }`. Default `true` - existing sitemap behaviour is byte-identical. `strings: false` blanks comments only, for scans where the string literal IS the signal. String literals are still traversed in both modes, so a `//` inside `"https://example.com"` can never be mistaken for a comment and blank the rest of the line.
- `test`: 4 regression tests - comment-only gtag passes, real gtag alongside comments still fails, `strings: false` preserves string bodies while blanking comments and preserving offsets, and code after a URL survives in both modes.

## [0.10.1] - 2026-07-31

- `fix(gate-conversion-instrumentation-source)`: `relaySecret` now also passes when the route delegates to `build-websites-tools/conversion-relay` instead of naming `GA4_API_SECRET` itself. WHY: v0.10.0 moved the secret read INTO the shared handler, so the migration target documented in that same release failed its own gate. Found immediately on migrating participation-effect-site - the first time the gate ran against a real repo rather than a fixture. Every fixture inlined the secret, so the 182-test suite was green while the documented path was broken. The invariant still fails a route that neither reads the secret nor adopts the shared relay, which is the risk it exists to catch (a relay quietly depending on client gtag).
- `test`: 2 regression tests - the shared-relay migration target passes all four invariants, and a route doing neither still fails.

## [0.10.0] - 2026-07-31

**BREAKING for every consumer.** `gate-conversion-instrumentation-source` enforced a defect; correcting it fails each site until it migrates. Migration path in README "Migration: v0.9.0 to v0.10.0".

- `fix(gate-conversion-instrumentation-source)`: the `relayInvoked` invariant required the client to **dual-fire** - to call `gtag("event", ...)` *and* POST to `/api/track`. That encoded an implementation SHAPE instead of an OUTCOME, and the shape was wrong. WHY: reviewing a GA4 report email for theparticipationeffect.com on 2026-07-31 (41 active users, 3.0K events, +236%) traced the numbers to their source. For a consenting visitor both paths deliver, under two different `client_id`s - the `_ga` cookie for gtag, a relay-minted `participation_cid` for the Measurement Protocol - so GA4 counted one Amazon click as two events and two users. The gate could not fail on this; worse, a site that fixed it would have failed `prebuild` with zero dual-fire callers. Replaced by `singleDelivery`: the relay must be invoked AND no invoker may also fire a client gtag event. `gtag` stays legitimate for engagement-only telemetry that never reaches the relay. The invocation-detection primitive (`evaluateRelayInvoked`) and all its edge cases - comment-only mentions, relay-dir helpers, top-level `lib/` - are unchanged and still tested.
- `feat(gate-conversion-instrumentation-source)`: new `sessionParams` invariant. The relay must send `session_id` and `engagement_time_msec`. WHY: all nine instrumented repos sent `{client_id, events}` and nothing else. GA4 answers `204` either way - accepted is not attributed - so events landed attached to no session, session-scoped dimensions read `(not set)`, and conversions could never be traced to a landing page, source, or campaign. Only a static check catches this, because the wire response is identical. Satisfied by adopting `build-websites-tools/conversion-relay` or by carrying both params in the site's own relay.
- `feat(conversion-relay)`: new `build-websites-tools/conversion-relay` subpath export, extracted from nine near-identical copies of `src/app/api/track/{route,logic}.ts` under the extract-on-third-consumer rule. `createTrackHandler` (framework-agnostic Web `Request` to `Response`), `resolveIdentity`, `buildMeasurementProtocolPayload`, `readGaClientId`, `readGaSessionId`, `parseCookies`, `sanitizeParams`, `isAllowedEvent`. Reuses the visitor's real `_ga` client id and `_ga_<CONTAINER>` session id when present (both GS1 and GS2 cookie formats), so server-sent events join the session GA4 already has instead of forking a parallel one; mints and persists a first-party id otherwise. Declares `consent: {ad_user_data: DENIED, ad_personalization: DENIED}` and withholds the IP for non-consenting visitors. Returns `503` with a named gap on missing config rather than a silent `200`, and treats any non-`204` upstream as `502`.
- `test`: 21 new `conversion-relay` tests and 8 new gate-contract tests. The gate-contract tests were written first and verified RED against v0.9.0 - `evaluateSource` returned `pass: true` for the exact shape shipped to seven repos - per the rule that an assertion which cannot fail on the defect proves nothing.
- **Backwards compatibility**: a `gate.config.json` carrying `checks.relayInvoked: false` still opts out of the renamed `singleDelivery` check, so an existing exception does not silently start failing.
- Audit trail: `_audit-vault` findings F-20260731-01 through -05, pattern `Pattern-Instrumented-But-Report-Never-Validated`.

## [0.9.0] - 2026-07-27

**BREAKING for any consumer whose sitemap does not already declare truthful dates.** Enforcement is on by default; see the staged-migration path below and in `docs/SITEMAP_LASTMOD_STANDARD.md`.

- `feat(sitemap-standard)`: the portfolio-wide rule that **`lastmod` = the last substantive content change**. Build time, deploy time, process start time, framework execution time, and "current time for every route" are not valid sources on their own. WHY: an audit of siteclinic.io on 2026-07-27 found 33 of its 54 sitemap URLs carrying one identical timestamp - `2026-07-23T08:15:38.802Z`, the moment of the last deploy - because `src/app/sitemap.ts` computed `const now = new Date()` once and reused it for every non-blog entry. Next re-evaluates the sitemap every build, so twice-weekly blog-publish commits restamped `/privacy` and `/about` (unchanged since May) as modified that morning. Google uses `lastmod` only while it is consistently accurate and discounts it site-wide once a sitemap over-reports freshness; Search Console showed 35 of that site's URLs in "Discovered - currently not indexed" with no trustworthy freshness hint. An honest but stale date costs nothing; an always-fresh date costs the whole signal.
- `feat(gate-sitemap-source)`: new static gate (no running server) that reads the sitemap's SOURCE and rejects the construct rather than the symptom. Detects `build-scoped-shared-date` (`const now = new Date()` reused across routes), `bare-new-date` (`new Date()` / `new Date().toISOString()`), and `date-now` (`Date.now()` as freshness). Reports file, line, matched source line, and remediation for each. Deliberately does NOT flag the supported freshness sources: `new Date(post.updatedAt)`, `new Date(entry.published ?? entry.target_date)`, and literal dates all pass - a gate that failed those would be disabled, and a disabled gate enforces nothing. Comments and string literals are blanked before matching (line numbers preserved), so documenting the prohibited pattern is not itself a violation. Per-line escape hatch `// bwt-allow-build-time-date` for a genuine clock read; per-line on purpose, there is no file-wide switch. Bin: `gate-sitemap-source`.
- `feat(gate-seo)`: sitemap.xml is now parsed as **structured records** (`loc` + `lastmod` + `changefreq` + `priority`) via a real XML parser instead of `/<loc>([^<]+)<\/loc>/g`. Beyond enabling the `lastmod` checks, this fixes two latent parsing defects: entity-escaped URLs (`&amp;` in a query string) were returned raw, and namespace-prefixed documents (`<sm:loc>`) were invisible. Extension namespaces are handled by matching direct children only, so a nested `<image:loc>` can never be mistaken for the page URL. A `<sitemapindex>` at `/sitemap.xml` is now reported explicitly rather than silently yielding zero URLs. All existing route-parity, redirect-contract, and internal-link-canonicality behaviour is unchanged.
- `feat(gate-seo)`: runtime `lastmod` validation against the served sitemap. Codes: `missing-lastmod`, `invalid-lastmod`, `future-lastmod`, `duplicate-loc`, `build-time-cluster` (N routes sharing one build-shaped instant), `build-time-smear` (N distinct build-shaped instants inside one build window - per-route `new Date()`), and `suspicious-lastmod-cluster` (N routes sharing one calendar day, above the configured threshold). The last two are separated on purpose: a shared calendar day is plausible and only tunable-reported, while a shared sub-second instant is a build stamp and fails regardless of threshold. Exact URLs are printed for every finding.
- `feat(sitemap)`: new `build-websites-tools/sitemap` subpath export. `defineSitemap` (typed route metadata to a stably-ordered, duplicate-checked entry list), `newestDate` (newest-child derivation for listing pages), `contentDate` (read stored content metadata), `normalizeIsoDate` / `normalizeIsoDay` (deterministic ISO normalization), `toNextSitemap` (Next.js `MetadataRoute.Sitemap` shape), and `validateSitemapEntries` - the same validator `gate-seo` runs, exported so a site can check itself. It **never** defaults `lastModified` to the current time: a missing date with no configured `fallbackLastModified` is a loud build failure, not a silent clock read. Pure, deterministic, dependency-free; two builds of unchanged content produce byte-identical output.
- `feat(config)`: `sitemap` block in `gate.config.json`. `enforce` (default `true`), `requireLastModified` (default `true`), `maxFutureSkewMinutes` (default `10`), `maxIdenticalLastmodCluster` (default `10`), `allowMissingLastmodRoutes`, `dynamicListingRoutes`.
- **Migration**: bump the pin and set `{"sitemap": {"enforce": false}}`. Both gates still run and print every finding in full, with exact URLs and source lines, but do not fail the build. There is deliberately no way to silence the findings - the only choice is whether they block. Fix the sitemap with `defineSitemap`, then delete the flag. Full guide: `docs/SITEMAP_LASTMOD_STANDARD.md`.
- `test`: 43 new cases (27 helper, 13 parser, 18 source-gate; 152 total suite). Every date-dependent test injects `now` rather than reading a clock - a test that passed only "today" would be the defect under audit.

## [0.7.1] - 2026-07-08

- `fix(related-content)`: drop the `[key: string]: unknown` index signature from the exported `ScheduleEntryLike` type. It forced a consumer's own schedule-entry type to declare a matching index signature or the whole array failed to typecheck when passed to `selectRelatedPosts` (`TS2345: Index signature for type 'string' is missing`). The helper only needs `{ slug, title, cluster? }`; without the index signature a consumer's richer entry type (keywords, dates, etc.) is structurally assignable with no cast. Found immediately on the first consumer (qirofit-web). Runtime behaviour unchanged; types-only.

## [0.7.0] - 2026-07-08

- `feat(related-content)`: new reusable related-content / internal-linking selection helper, exposed as the `build-websites-tools/related-content` subpath export. Pure, deterministic, framework-agnostic (no React, no DOM, no new deps, no build step) - consumers render the returned data with their own components so each site's design and copy tone stay site-owned. Operates on the standard blog-schedule shape (`{ slug, title, cluster? }`). API: `selectRelatedPosts` (same-cluster siblings, current-post excluded, optional cross-cluster fill), `relatedServices` (cluster→service mapping with per-slug override + default fallback), `featuredPosts` (homepage featured), `servicePageEducationLinks` (cornerstone-first). Configurable limits (defaults 3 related articles / 2 services / 3 featured / 6 service-education) and per-site overrides. WHY: liddy-podiatry-site and qirofit-web independently showed the identical builder-pattern gap - near-orphaned blog posts with no post→sibling, post→service, or service→post links - triggering the extract-before-duplicate rule (PROJECT_MAP builder-framework section). First consumer: qirofit-web. Unit-tested (8 cases: sibling selection, current-post exclusion, limit enforcement, empty/missing-cluster fallback, cluster→service mapping, service→post mapping, per-slug override, determinism). No gate behaviour changed; purely additive - sites on v0.6.0 are unaffected until they opt in.

## [0.6.0] - 2026-06-22

- `feat(gate-dashboard-parity)`: new site-side dashboard-readiness meta-gate (Phase 3, Option A). Composes the existing readiness gates - `gate:ada`, `gate:seo`, `gate:ai-instrumentation-source`, `gate:conversion-instrumentation-source` - by spawning them and aggregating; fails the build (naming the gap) if a marketing site is missing any surface a Site Clinic dashboard reads. Does not duplicate gate logic - it orchestrates them so a site cannot ship sub-parity. The **site side** of board parity (MASTER_VISIBILITY_MATRIX §17.3.1.2, three-pillar standard); the **board side** is enforced by site-monitor's `billableClientParity` contract test. The shared-manifest Option B is deferred. Bin: `gate-dashboard-parity`. Policy (required-surface set + aggregation) is unit-tested, including the missing-surface fail case. Not yet wired into any consumer's `gate:all` (per-site rollout - it replaces the individual readiness-gate calls). Docs: `docs/GATE_DASHBOARD_PARITY.md`. babymilestonejournal.com promotion context: site-monitor PR #66.

## [0.5.2] - 2026-06-17

- `fix(gate-conversion-instrumentation-source)`: `relayInvoked` now walks the whole consumer tree from cwd instead of a fixed `["src","app",...]` root list, so it finds dual-fires in top-level `lib/` and `components/` dirs of app-router projects that have no `src/` dir. Found 2026-06-17 wiring daily-rise (apps/web), whose dual-fire lives in `lib/client/bookAnalytics.ts` and was invisible to the old scan (false FAIL on relayInvoked). Sites with `src/`-nested code (the other consumers) were never mis-evaluated. Regression test added; 64/64 suite green. Fix-the-class per MASTER_VISIBILITY_MATRIX §17.3.1.2.

## [0.5.1] - 2026-06-17

- `fix(gate-conversion-instrumentation-source)`: `relayInvoked` now requires an HTTP-call token (`fetch(`/`sendBeacon`/`XMLHttpRequest`/`axios`/`.post(`) alongside the `/api/track` reference, so a bare mention of the relay path in a COMMENT no longer falsely counts as a dual-fire. Found 2026-06-17 wiring bmj-marketing: a `Button` component documenting the relay in a comment satisfied the old string-only check. Without the fix a site with a comment-only mention and no real dual-fire could falsely pass. Regression test added (comment-only mention must not count). 63/63 suite green. Fix-the-class per MASTER_VISIBILITY_MATRIX §17.3.1.2 propagation rule.

## [0.5.0] - 2026-06-17

- `feat(gate-conversion-instrumentation-source)`: new static gate enforcing the Conversion Instrumentation Contract (MASTER_VISIBILITY_MATRIX §17.3.1.2, added 2026-06-17). Three plumbing invariants, no running server required: (1) exactly one `/api/track` route, (2) the route forwards server-side via `GA4_API_SECRET` (a consent-independent GA4 Measurement Protocol relay, not consent-gated client gtag), (3) client code outside the relay directory dual-fires to `/api/track`. Catches the failure class found on liddy-podiatry-site 2026-06-17: conversion clicks fired only through `window.gtag` were dropped for non-consenting visitors, so the dashboard showed zero conversions despite wiring being present. The fix (proven on Liddy, live in production) is the server-side relay this gate enforces. Which events a site emits is deliberately NOT checked here (site-specific; enforced downstream by Site Monitor's dogfood contract). NOT added to any consumer's `gate:all` yet: only sites that have wired the relay should enable it (per-site rollout), since a hard gate on a site without a relay would break its build. Bin: `gate-conversion-instrumentation-source`. Config: `conversionInstrumentation.source` in gate.config.json (skip reason or per-check toggles), mirroring `aiInstrumentation.source`. 7 detection-pattern tests; 62/62 suite green.

## [0.4.1] - 2026-06-09

- `fix(ensure-base-url)`: gate server cleanup now kills the whole launch process group (spawn `detached: true` + `process.kill(-pid)`), not just the wrapper process. When `launchCommand` is an npm wrapper (`npm run dev ...`), the old `child.kill` left the grandchild `next-server` orphaned; it held the inherited stdio pipes open and hung any caller waiting on the gate through `execFile` pipes. Observed 2026-06-09: jeffrystein-web blog-writer publish runs 26807810529 and 27193501696 cancelled at the 10-minute job timeout with an orphaned `next-server (v16.2.7)` in the runner teardown. Regression test `src/__tests__/ensure-base-url.test.ts` launches a real wrapper -> grandchild-server tree and asserts the grandchild dies after cleanup (red on the old code, green on the fix). POSIX-only semantics; gates run on macOS dev machines and ubuntu CI. Also tagged as `v0.3.3` (same fix cherry-picked onto `v0.3.2`) for consumers still pinned to the 0.3.x line.

## [0.4.0] - 2026-06-08

- `feat(gate-source)`: per-site GA4 property uniqueness invariant in `gate-ai-instrumentation-source`.
- `feat(gate-ada)`: terminal PASS and FAIL lines now annotate the scan mode when the gate falls back to html-snapshot (`gate:ada  PASS  [html-snapshot mode; color-contrast not evaluated, rerun in browser mode for full WCAG 2.1 AA coverage]`). The early-run warning is unchanged; this duplicates it on the terminal line that most operators scan first in long build logs. Triggered by siteclinic-web commit `7bb07a6` (2026-06-08), which shipped a serious color-contrast violation through a green Vercel build because the early warning was buried in the build log. Browser-mode output is unchanged. Same exit codes.
- `fix(sonar)`: 4 launcher `main()` calls converted from `.catch()` promise chain to top-level `try { await main() } catch` (S7785). Module target is ES2022, so top-level await is supported natively by both tsx and Node 20. Smoke-tested all 4 bins from `/tmp`; behavior unchanged.
- `chore(fallow)`: `.fallowrc.json` declares the 12 entry points (4 bin launchers, 4 src gate programs, 4 tests) so `fallow dead-code` reports zero issues instead of the previous 8 false-positive "unused files."
- `docs(readme)`: added a "Common pitfalls" section covering the three onboarding gaps a fresh consumer hits during the first integration. https-canonical override, Next.js openGraph wholesale-replacement, and the `aiInstrumentation.checks.ga4: false` opt-out for no-analytics sites. Each pitfall ships with the minimum code or config snippet that resolves it. Source: end-to-end audit at https://github.com/drjliddy-max/bwt-sample-site (live demo at https://bwt-sample-site.vercel.app), where the same three failures surfaced before docs were extended.
- `docs(readme)`: extended the Config schema table with `aiInstrumentation.checks` and `aiInstrumentation.skip` rows. The opt-out paths existed in source since `v0.2.0` but were not documented at the consumer surface. The only way to discover them was to read `src/gate-ai-instrumentation.ts`.

## [0.3.2] - 2026-06-08

- `chore(hygiene)`: portfolio audit (Sonar + Fallow + Graphify) cleanup. Removed 146 em/en dashes from source, tests, and bin wrappers per the portfolio no-long-dashes rule. Added `src/__tests__/no-long-dashes.test.ts` as a drift-prevention guard on src, bin, and top-level docs.
- `fix(sonar)`: unnecessary backtick escape removed from two regex character classes (`gate-ai-instrumentation-source.ts`). Nested template literal in `gate-seo.ts:249` lifted to a local. In-place `.sort()` in tests replaced with `[...arr].sort()` to avoid mutation (S4043).
- `refactor(bin)`: extracted shared spawn-tsx launcher to `bin/_run.mjs`. The four bin entries are now 3 to 7 lines each, delegating to `runGate({ binFileUrl, scriptName, gateLabel })`. Net 86 lines removed from bin/.
- No behavior change. 47/47 tests pass (46 prior plus the new dash guard).

## [0.3.1] - 2026-06-07

- Reworked `README.md` in the lead-magnet shape used by `design-os-template`: opens with problem framing, walks the four-gate process, includes "Used by" live customer list, lays out the free / paid boundary (gates free, Site Clinic monitoring paid), and adds a creator-credit section linking back to Site Clinic.
- Added `CHANGELOG.md` for release-history visibility.
- No code change; docs and release-process improvements only.

## [0.3.0] - 2026-06-07

First public release of the package. Repo flipped public; consumers migrate from vendored `file:tools/build-websites-tools` to versioned GitHub pin `github:drjliddy-max/build-websites-tools#v0.3.0`. Same four gates; consumption topology changed to close the vendoring drift class.

- Added `LICENSE` (MIT).
- Added `AGENTS.md` for standardized AI-agent onboarding (Claude Code, Codex, Cursor, Aider).
- Added `CLAUDE.md` for Claude-Code-specific contributor notes.
- Added `llms.txt` for AI-ingestion discoverability at the repo root.
- Added `templates/` directory with copyable `gate.config.json` shapes per site type (`marketing-site.json`, `blog.json`, `app-with-protected-routes.json`).
- Polished `README.md` for public-facing audience: problem framing, four-gate process, Used By list, "what Site Clinic adds on top" upsell, Free / Paid framing, creator credit.
- Package `package.json` updated: removed `private: true`, added license, author, repository, homepage, bugs, keywords for npm and GitHub discoverability.
- No code changes; same four gate bins behave identically.

## [0.2.2] - 2026-06-05

- `fix(bin)`: `require.resolve("tsx")` not `"tsx/dist/loader.mjs"` (subpath not exported); carry `launchCommand` support in `gate-ai-instrumentation`.

## [0.2.1] - 2026-06-05

- `fix(bin)`: resolve tsx via `createRequire` so the bin works for both `file:` and github-tarball install topologies.

## [0.2.0] - 2026-06-05

- `refactor(gate-ai-instrumentation)`: decouple from `loadGateConfig()`, read `gate.config.json` directly for the `aiInstrumentation` field. Orthogonal concerns separated.
- `feat(load-config)`: required-pages check now enforces `/`, `/privacy`, `/terms`, `/accessibility`, `/contact` per the build-websites-template build standard. No opt-out flag.
- `feat(matrix §17.3.1.2)`: `gate:ai-instrumentation-source` static prevention gate added. Catches refactor regressions that drop AI Instrumentation Contract surfaces before they ever launch a server.

## [0.1] - 2026-04 (initial)

- Initial release: `gate-ada` + `gate-seo` consumed by `siteclinic-web` only.
