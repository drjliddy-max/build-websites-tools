# Changelog

Get notified of major releases by subscribing at [siteclinic.io](https://siteclinic.io).

## [Unreleased]

- `ci`: public GitHub Actions workflow (`.github/workflows/ci.yml`) running typecheck + the full detection-pattern test suite on every push and PR, with a README badge. The test-suite claim is now continuously reproduced in public, per the trust-stack reproducibility rule. Companion workflow on [bwt-sample-site](https://github.com/drjliddy-max/bwt-sample-site) runs all four gates end to end weekly and on push.
- `docs`: GitHub Releases published for every tag v0.2.0 through v0.4.1, notes sourced from this changelog.

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
