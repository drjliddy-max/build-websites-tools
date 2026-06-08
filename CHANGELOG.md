# Changelog

Get notified of major releases by subscribing at [siteclinic.io](https://siteclinic.io).

## [Unreleased]

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
