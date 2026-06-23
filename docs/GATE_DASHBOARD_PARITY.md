# gate:dashboard-parity - site-side dashboard-readiness meta-gate

**Status:** Phase 3, **Option A** (site-side composition) - added 2026-06-22.
**Doctrine:** `MASTER_VISIBILITY_MATRIX.md` §17.3.1.2 (board equal-capability, three-pillar standard).

## What it does

`gate:dashboard-parity` enforces the **site side** of board parity: a marketing
site cannot ship unless it provides every surface a Site Clinic dashboard reads.
It does this by **composing** (running) the existing readiness gates and
aggregating - it does **not** duplicate their logic:

| Composed gate | Readiness surface it guarantees |
|---|---|
| `gate:ada` | Accessibility (WCAG 2.1 AA) |
| `gate:seo` | Indexability / canonical / structured data |
| `gate:ai-instrumentation-source` | `llms.txt`, robots AI policy, JSON-LD, GA4 |
| `gate:conversion-instrumentation-source` | `/api/track` relay + consent-independent dual-fire |

If any required gate fails, the build fails with a named list of the missing
surfaces. The AI **runtime** probe (`gate:ai-instrumentation`) is intentionally
not composed here - it needs a live server; the `-source` static variant is the
build-time-capable check.

## Why "Baby Milestone lockdown" does not exclude the marketing site

The Baby Milestone **app** is under release lockdown, but
`babymilestonejournal.com` is the **owned marketing site** - an operated board
like ada / siteclinic / participation. It was promoted to a first-class
Site Monitor pipeline on 2026-06-22 (site-monitor PR #66). The lockdown applies
to the app code, not the marketing site; the two are separate surfaces.

## Two-sided enforcement (with site-monitor)

- **Site side (this gate):** the site ships every board-readable surface.
- **Board side (site-monitor):** `__tests__/billableClientParity.test.ts` fails
  CI if an operated board is missing from any truth-layer registry.

Together they make parity self-enforcing on both ends.

## Option B - deferred

A **shared pipeline manifest** that this gate would cross-check against
site-monitor's registries (closing the cross-repo loop in code) is deferred.
Today the board-side registration is enforced by the site-monitor contract test;
Option B would add a committed manifest both repos honor. Revisit if cross-repo
drift appears.

## Usage

Wire into a consuming site's `gate:all` / `prebuild` (replacing the individual
readiness gate calls - `gate:dashboard-parity` runs them as one). Each composed
gate still reads `gate.config.json` from the site's repo root.
