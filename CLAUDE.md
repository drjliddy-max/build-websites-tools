# CLAUDE.md

Claude-Code-specific notes for this repository. For general AI-agent guidance, see `AGENTS.md`.

## Repository purpose

This is `build-websites-tools`, a build-time enforcement gate package consumed by every owned site in John Liddy's portfolio. It enforces WCAG 2.1 AA, Google indexing rules, and an AI Instrumentation Contract at `prebuild`. Failures block deploys.

## When asked to modify this repo

1. Read the README first. It states what the package is, what each gate enforces, and the schema for `gate.config.json`.
2. Read `AGENTS.md` for the standard onboarding flow.
3. Read the source of the specific gate before modifying it: `src/gate-ada.ts`, `src/gate-seo.ts`, `src/gate-ai-instrumentation.ts`, `src/gate-ai-instrumentation-source.ts`, `src/load-config.ts`.
4. Run the tests: `npm test`. They live in `src/__tests__/` and use the Node test runner.
5. Run typecheck: `npm run typecheck`.

## When asked to add a gate

A new gate is appropriate when there is a class of production regression that affects multiple owned sites and can be detected at build time with a deterministic rule. Examples that fit: "every site must serve `llms.txt` with a Markdown heading." Examples that do not fit: "this one site needs a custom config check" (that belongs in the consuming site, not in the shared gate).

When adding a gate:

1. Implement under `src/gate-<name>.ts`. Export a function the bin can call.
2. Add the bin wrapper at `bin/gate-<name>.mjs` that loads the gate via tsx and exits with the gate's status.
3. Update `package.json` `bin` field to register the new gate.
4. Add tests under `src/__tests__/gate-<name>.test.ts`. Test the positive path, the negative path, and at least one edge case.
5. Update `README.md`'s gate table.
6. Bump the version in `package.json` (minor bump for a new gate, patch for a bug fix).
7. Tag the release: `git tag v0.X.0 && git push --tags`.

## When asked to fix a gate

Same flow, but the test for the bug case is mandatory before the fix. Reproduce the bug as a failing test first; then fix the gate code; the test should turn green. This is how `fix(tests): add localeCompare to .sort() calls (SonarQube S2871)` (commit `ddda755`) was shipped.

## Consumers

Live consumers (every commit here can affect every one of these on next deploy):

- siteclinic.io
- liddypodiatryandprevention.com
- babymilestonejournal.com
- adaauditreport.com
- theparticipationeffect.com
- daily-rise.com
- jeffrystein.com

A change that tightens a gate (new failure mode) is a breaking change for any consumer whose current site violates the new rule. Bump the version accordingly and document the migration path in the commit body.

## Drift prevention

This package exists in part to eliminate the previous vendored-tools drift class (consumers carrying stale copies of these files under `tools/build-websites-tools/`). Do NOT recreate the vendoring pattern. Consumers should always install via `github:drjliddy-max/build-websites-tools#vX.Y.Z`. If a consumer needs a feature not in the latest tag, ship the feature here, tag, and have the consumer bump.

## Hard rules

- Do not skip tests or typecheck before committing. `npm test && npm run typecheck` is the local gate.
- Do not introduce gate behavior that depends on filesystem paths outside the consuming site's working directory. Gates must be portable across operating systems and CI runners.
- Do not emit info-level output on success. The bin script should be silent on success and loud on failure.
- Do not pin Node to a specific minor version. The package targets Node 20+; require what the language and dependencies need.
