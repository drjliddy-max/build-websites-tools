# AGENTS.md

Standardized instructions for AI agents (Claude Code, Codex, Cursor, Aider, custom agents) using this package to build or maintain a website.

## What this package is

`build-websites-tools` is a set of four build-time enforcement gates for production websites. The gates fail the build before deploy if the site violates WCAG 2.1 AA accessibility, Google indexing rules, or the AI Instrumentation Contract (`robots.txt` per-bot rules, `llms.txt`, AI ingestion endpoint, homepage JSON-LD). Every site that adopts this package gates its `prebuild` step on `gate-ada && gate-seo && gate-ai-instrumentation-source && gate-ai-instrumentation`.

## When an agent should use this package

Use it when the user is:

- Building a new marketing site, blog, or web app and asks for accessibility / SEO / AI-discoverability gates.
- Adding ADA WCAG 2.1 AA enforcement to an existing site.
- Wiring `robots.txt` per-bot rules, `llms.txt`, or JSON-LD baseline checks.
- Investigating a Google Search Console "Excluded by noindex," "Page with redirect," or "Discovered, currently not indexed" finding.
- Auditing a site for required pages (`/`, `/privacy`, `/terms`, `/accessibility`, `/contact`).

Do NOT use it for:

- Runtime ADA monitoring (use a paid auditor or a runtime axe scan instead).
- Sites that need only one of the gates and reject the four-gate bundle.
- Sites with no `gate.config.json` and no willingness to maintain one.

## Task: wire the gates into an existing site

1. Read the site's current `package.json` and `gate.config.json` (if any).
2. Add the dependency:
   ```bash
   npm install --save-dev "github:drjliddy-max/build-websites-tools#v0.1.0"
   ```
3. Add scripts to `package.json`:
   ```json
   "scripts": {
     "gate:ada": "gate-ada",
     "gate:seo": "gate-seo",
     "gate:ai-instrumentation": "gate-ai-instrumentation",
     "gate:ai-instrumentation-source": "gate-ai-instrumentation-source",
     "gate:all": "npm run gate:ada && npm run gate:seo && npm run gate:ai-instrumentation-source && npm run gate:ai-instrumentation",
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

- `gate-ada` failure → axe-core violation. The output names the WCAG rule and the offending DOM selector. Fix in the source (markup or styling), do not suppress in the gate.
- `gate-seo` failure → meta tag, sitemap, or canonical issue. The output names the route and the violated rule. Fix in the source (page metadata, sitemap config, or `robots.txt`).
- `gate-ai-instrumentation-source` failure → a matrix §17.3.1.2 surface is missing from source (no `robots.txt`, no `llms.txt`, no JSON-LD baseline, or no AI ingestion endpoint). Add the surface.
- `gate-ai-instrumentation` failure → the live build is missing one of those surfaces. Usually means a route handler returns wrong content-type or wrong body. Inspect the failing URL.

If a gate is producing a false positive (rare), open an issue against this repo with the URL, the gate output, and the expected behavior. Do NOT bypass the gate with `--no-verify` or by removing the prebuild step.

## Task: upgrade to a newer version

1. Check the latest tag: `git ls-remote --tags https://github.com/drjliddy-max/build-websites-tools | tail -5`
2. Update the dependency in `package.json`:
   ```diff
   - "build-websites-tools": "github:drjliddy-max/build-websites-tools#v0.1.0"
   + "build-websites-tools": "github:drjliddy-max/build-websites-tools#v0.2.0"
   ```
3. Run `npm install` to fetch the new version.
4. Run `npm run gate:all`. If any gate now fails that previously passed, the new version added or tightened a rule. Read the failure and fix the site (the new rule is intentional). Do not pin back.
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

## Where to read more

- `README.md`: full feature list, schema, install.
- `CLAUDE.md`: Claude-Code-specific notes if you are running as Claude.
- `llms.txt`: structured summary for AI ingestion.
- `templates/`: copyable `gate.config.json` shapes.
