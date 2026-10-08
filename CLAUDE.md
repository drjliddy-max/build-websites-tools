# CLAUDE.md

Claude-Code-specific notes for this repository. For general AI-agent guidance, see `AGENTS.md`.

Inherits `~/.claude/CLAUDE.md` and `Projects/CLAUDE.md`. This file adds only repo-specific rules.

## Repository purpose

This is `build-websites-tools`, a build-time enforcement gate package consumed by every owned site in John Liddy's portfolio. It enforces WCAG 2.1 AA, Google indexing rules, and an AI Instrumentation Contract at `prebuild`. Failures block deploys.

## When asked to modify this repo

1. Read the README first. It states what the package is, what each gate enforces, and the schema for `gate.config.json`. Note the gate table: **`gate:all` is three commands and runs nine gates**, because `gate-dashboard-parity` is a meta-gate that spawns six leaves. Do not infer from a consuming site's `scripts` block that a gate is unwired.
2. Read `AGENTS.md` for the standard onboarding flow.
3. Read the source of the specific gate before modifying it. Gate sources are `src/gate-*.ts` (shared config loading: `src/load-config.ts`); the blog-writer estate gate is `bin/gate-blog-canonical.mjs` over `src/blog-writer/`. The `package.json` `bin` field is the authoritative gate list.
4. Run the tests: `npm test`. The `test` script in `package.json` defines the set (currently `src/__tests__/` and `src/blog-writer/__tests__/`, Node test runner via tsx).
5. Run typecheck: `npm run typecheck`.

## When asked to add a gate

A new gate is appropriate when there is a class of production regression that affects multiple owned sites and can be detected at build time with a deterministic rule. Examples that fit: "every site must serve `llms.txt` with a Markdown heading." Examples that do not fit: "this one site needs a custom config check" (that belongs in the consuming site, not in the shared gate).

When adding a gate:

1. Implement under `src/gate-<name>.ts`. Export a function the bin can call. **Guard the entry point** so `main()` runs only under direct invocation, and export the policy helper the tests will call: see [`docs/GATE_MODULE_CONTRACT.md`](./docs/GATE_MODULE_CONTRACT.md). A gate that calls `main()` at top level runs the whole gate on import and cannot be unit-tested; `src/__tests__/gate-import-safety.test.ts` fails the build if you skip this.
2. Add the bin wrapper at `bin/gate-<name>.mjs` that loads the gate via tsx and exits with the gate's status.
3. Update `package.json` `bin` field to register the new gate.
4. Add tests under `src/__tests__/gate-<name>.test.ts`. Test the positive path, the negative path, and at least one edge case.
5. Update `README.md`'s gate table.
6. Bump the version in `package.json` (minor bump for a new gate, patch for a bug fix), update the install pins inside the README `RELEASE-PIN` block to match (enforced by `src/__tests__/docs-contract.test.ts`), and add a `CHANGELOG.md` entry.
7. After the PR merges, tag the merged `main` commit: `git tag v0.X.0 <merged-sha> && git push origin v0.X.0`.
8. Adoption is separate: the estate-approved release advances only by operator approval in portfolio-os `sources/estate/builder-release.json`. A tag here changes no consumer.

## When asked to fix a gate

Same flow, but the test for the bug case is mandatory before the fix. Reproduce the bug as a failing test first; then fix the gate code; the test should turn green. This is how `fix(tests): add localeCompare to .sort() calls (SonarQube S2871)` (commit `ddda755`) was shipped.

## Consumers

A commit or tag here changes no consumer by itself. Consumers install via an immutable GitHub tag pin (`github:drjliddy-max/build-websites-tools#vX.Y.Z`); a change reaches a consumer only when that consumer's pin is advanced **and** reinstalled so its lockfile's resolved SHA moves. A tag is a release, not adoption.

- Consumer roster and per-consumer adoption: `cd ../portfolio-os && npm run estate:drift` (reads each consumer's `origin/main`). Do not hand-maintain a consumer list here.
- Estate-approved release: portfolio-os `sources/estate/builder-release.json`, advanced only by operator approval.

A change that tightens a gate (new failure mode) is a breaking change for any consumer whose current site violates the new rule. Bump the version accordingly and document the migration path in the commit body.

## Drift prevention

This package exists in part to eliminate the previous vendored-tools drift class (consumers carrying stale copies of these files under `tools/build-websites-tools/`). Do NOT recreate the vendoring pattern. Consumers should always install via `github:drjliddy-max/build-websites-tools#vX.Y.Z`. If a consumer needs a feature not in the latest tag, ship the feature here, tag, and have the consumer bump.

## Hard rules

- Do not skip tests or typecheck before committing. `npm test && npm run typecheck` is the local gate.
- Do not introduce gate behavior that depends on filesystem paths outside the consuming site's working directory. Gates must be portable across operating systems and CI runners.
- Exit status is the contract: zero on pass, non-zero on any failure, and failure output must name the failing check. Gates currently print a short scope/summary line on success (e.g. `gate:sitemap-source  PASS: ...`), and the `gate-dashboard-parity` meta-gate prints a composition banner and a section per child gate; keep success output to that kind of summary, not per-item noise.
- Do not pin Node to a specific minor version. `package.json` declares no `engines` field; CI (`.github/workflows/ci.yml`) runs Node 22. Require only what the language and dependencies need.
