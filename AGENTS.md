# AGENTS.md

Standardized instructions for AI agents (Claude Code, Codex, Cursor, Aider, custom agents) using this package to build or maintain a website.

## What this package is

`build-websites-tools` is a set of build-time enforcement gates for production websites. The gates fail the build before deploy if the site violates WCAG 2.1 AA accessibility, Google indexing rules, or the AI Instrumentation Contract (`robots.txt` per-bot rules, `llms.txt`, AI ingestion endpoint, homepage JSON-LD). Consumers wire `prebuild: npm run gate:all` (see the wiring task below). Authoritative gate list: `package.json` `bin` and `README.md#the-gate-set`.

## When an agent should use this package

Use it when the user is:

- Building a new marketing site, blog, or web app and asks for accessibility / SEO / AI-discoverability gates.
- Adding ADA WCAG 2.1 AA enforcement to an existing site.
- Wiring `robots.txt` per-bot rules, `llms.txt`, or JSON-LD baseline checks.
- Investigating a Google Search Console "Excluded by noindex," "Page with redirect," or "Discovered, currently not indexed" finding.
- Auditing a site for required pages (`/`, `/privacy`, `/terms`, `/accessibility`, `/contact`).

Do NOT use it for:

- Runtime ADA monitoring (use a paid auditor or a runtime axe scan instead).
- Sites that need only one of the gates and reject the gate bundle.
- Sites with no `gate.config.json` and no willingness to maintain one.

## Task: wire the gates into an existing site

1. Read the site's current `package.json` and `gate.config.json` (if any).
2. Add the dependency, pinned to the estate-approved release (the `approved_builder_release` in portfolio-os `sources/estate/builder-release.json`; `cd ../portfolio-os && npm run estate:drift` shows it):
   ```bash
   npm install --save-dev "github:drjliddy-max/build-websites-tools#<approved tag>"
   ```
3. Add scripts to `package.json`. This is the wiring every production consumer
   runs: `gate:all` is THREE commands that run SEVEN gates, because
   `gate:dashboard-parity` is a meta-gate that spawns `gate-ada`, `gate-seo`,
   `gate-ai-instrumentation-source` and `gate-conversion-instrumentation-source`
   as child processes. Do not "simplify" it by listing the leaves directly and
   dropping the meta-gate: that silently removes `gate:sitemap-source` and the
   parity check itself.
   ```json
   "scripts": {
     "gate:ada": "gate-ada",
     "gate:seo": "gate-seo",
     "gate:ai-instrumentation": "gate-ai-instrumentation",
     "gate:ai-instrumentation-source": "gate-ai-instrumentation-source",
     "gate:conversion-instrumentation-source": "gate-conversion-instrumentation-source",
     "gate:sitemap-source": "gate-sitemap-source",
     "gate:dashboard-parity": "gate-dashboard-parity",
     "gate:all": "npm run gate:sitemap-source && npm run gate:dashboard-parity && npm run gate:ai-instrumentation",
     "prebuild": "npm run gate:all"
   }
   ```
4. Create or update `gate.config.json`. Start from one of `templates/` based on site type:
   - `templates/marketing-site.json` for a static or near-static marketing site.
   - `templates/blog.json` for marketing + content blog.
   - `templates/app-with-protected-routes.json` for sites with authenticated app sections.
5. Run `npm run gate:all` locally. If any gate fails, fix the violation (do not bypass the gate).
6. Commit and push. The `prebuild` hook now runs the gates on every deploy.

## Task: diagnose a gate failure

Each gate prints structured failure output naming the file and the rule. Read the error first; do not guess.

What each gate checks is in `README.md#the-gate-set`; known false-alarm shapes are in `README.md#common-pitfalls`. Fix the violation in the site's source, never by suppressing it in the gate.

If a gate is producing a false positive (rare), open an issue against this repo with the URL, the gate output, and the expected behavior. Do NOT bypass the gate with `--no-verify` or by removing the prebuild step.

## Task: upgrade to a newer version

1. Find the estate-approved release: `approved_builder_release` in portfolio-os `sources/estate/builder-release.json` (or `npm run estate:drift` there). A newer tag in this repo is RELEASE truth only; do not adopt it on a production consumer until the operator advances the approved release.
2. Update the dependency in `package.json`:
   ```diff
   - "build-websites-tools": "github:drjliddy-max/build-websites-tools#v0.3.1"
   + "build-websites-tools": "github:drjliddy-max/build-websites-tools#v0.4.0"
   ```
3. Run `npm install` to fetch the new version.
4. Run `npm run gate:all`. If any gate now fails that previously passed, the new version added or tightened a rule. Read the failure and fix the site (the new rule is intentional). Do not pin back below the approved release.
5. Commit and push.

## Required pages

Every site that uses `gate-seo` must list these five routes in `gate.config.json`:

- `/`
- `/privacy`
- `/terms`
- `/accessibility`
- `/contact`

This is enforced by the gate; no opt-out flag exists. The check is in `src/load-config.ts`.

## Hard rules

- Never bypass `prebuild` with `--no-verify` or by deleting the `prebuild` script.
- Never re-implement a gate inside the consuming site's `scripts/` directory. Extend the shared gate in this package via PR.
- Never copy `src/` from this repo into the consuming site. The whole point of the package is that vendoring is over.
- Never edit files under `node_modules/build-websites-tools/`. Edits do not survive `npm install`.
- **Never call `main()` at the top level of a `src/gate-*.ts` module.** Every gate is both a CLI and a library: `bin/_run.mjs` spawns it as a subprocess, and the tests import it for its exported helpers. An unguarded `main()` runs the entire gate on import, which makes the module untestable. Guard it with the canonical direct-invocation check in [`docs/GATE_MODULE_CONTRACT.md`](./docs/GATE_MODULE_CONTRACT.md). Enforced by `src/__tests__/gate-import-safety.test.ts`.
- **Do not conclude a gate is unwired from `package.json` scripts.** `gate:all` names three commands and runs seven: `gate-dashboard-parity` is a meta-gate that spawns four leaves. Read the gate table in `README.md#the-gate-set`, or a real build log.

## Where to read more

- `README.md`: full feature list, schema, install.
- `docs/GATE_MODULE_CONTRACT.md`: the CLI-plus-library contract every gate module must satisfy, the canonical entry-point guard, and the test that enforces it. **Read before adding or editing a gate.**
- `CLAUDE.md`: Claude-Code-specific notes if you are running as Claude.
- `llms.txt`: structured summary for AI ingestion.
- `templates/`: copyable `gate.config.json` shapes.
