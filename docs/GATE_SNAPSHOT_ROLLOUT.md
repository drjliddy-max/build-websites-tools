# gate-snapshot — release and consumer rollout

**Status:** planned, **not executed**. Nothing in this document has been run.
**Implementation branch:** `feat/gate-snapshot-phase1`
**Version:** v0.13.0 (v0.12.0 was taken by the fail-closed GA4 contract)

---

## Why the rollout is staged this way

The fleet starts accumulating evidence at **step 5**, before any ingestion endpoint or dashboard exists. That ordering is deliberate: history starts at first emission and cannot be recovered retroactively, so every day of delay is a day of baseline that no later work can reconstruct. Building the consumer surface first would be more satisfying and would cost real evidence.

The canary is `bwt-sample-site` because it is the public showcase, has no client impact, and is currently four minor versions behind — so the canary bump also fixes the most visible version drift in the fleet.

---

## Release sequence (operator-authorized steps marked ⚠️)

### 1. Review and merge the package change

```bash
cd <build-websites-tools checkout>
npm test && npm run typecheck        # expect 276/276, typecheck clean

⚠️ git push -u origin feat/gate-snapshot-phase1
⚠️ gh pr create --base main --title "feat(gate-snapshot): preserve what the build already measured (Phase 1)" --body-file docs/GATE_SNAPSHOT_ROLLOUT.md
⚠️ # review, then merge
```

### 2. Tag v0.13.0

```bash
⚠️ cd <build-websites-tools checkout>
⚠️ git checkout main && git pull
⚠️ git tag v0.13.0
⚠️ git push origin v0.13.0
   git ls-remote --tags origin | grep v0.13.0     # verify the tag resolves
```

### 3. Canary: `bwt-sample-site` (v0.9.0 → v0.13.0)

This is a **four-version jump**. It crosses the v0.10.0 conversion-gate breaking change and the v0.12.0 fail-closed GA4 contract, so it is a real migration, not a bump.

```bash
cd <consumer site checkout>
# read both migration notes in the builder README before running this
npm install --save-dev "github:drjliddy-max/build-websites-tools#v0.13.0"
npm run gate:all                      # must pass BEFORE snapshots are enabled
```

If `gate:all` fails after the jump, that is the v0.10.0/v0.12.0 migration surfacing, **not** a gate-snapshot problem. Fix the migration first; snapshot emission is inert and cannot be the cause.

### 4. Enable emission on the canary

```bash
cd <consumer site checkout>
GATE_SNAPSHOT_DIR=.gate-snapshots npm run gate:all
GATE_SNAPSHOT_DIR=.gate-snapshots npm run gate:snapshot
echo ".gate-snapshots/" >> .gitignore   # snapshots are build artifacts, never committed
```

### 5. Verify the first real snapshot

Check every one of these before going wider:

| Check | Expected |
|---|---|
| Schema | validates against `schema/build-snapshot-v1.schema.json` |
| Secrets | no `G-`, `AIza`, `sk_live`, `postgres://`, `Bearer`, `-----BEGIN`, no `/Users/` paths |
| `build.environment` | `local` from a laptop, `production` only from a Vercel production build |
| `summary.comparability.adaScanMode` | present — `browser` locally, likely `html-snapshot` on Vercel |
| `completeness.status` | `complete` when the whole chain ran |
| `build.commitSha` | a real SHA, not null, not invented |
| `snapshotId` | stable across two merges of the same build |

```bash
node -e 'const s=require("./.gate-snapshots/snapshot.json");
 console.log(s.build.environment, s.summary.comparability.adaScanMode, s.completeness.status, s.build.commitSha)'
grep -ciE "G-[A-Z0-9]{6,}|AIza|sk_live|postgres://|/Users/" .gate-snapshots/snapshot.json   # expect 0
```

### 6. Collect at least two snapshots

Do **not** build any diff or dashboard surface until two snapshots exist for one site. With one snapshot there is nothing to compare and the comparability logic is untested against real data.

### 7. Fleet rollout

Nine sites are on v0.11.3 or v0.12.0 and move to v0.13.0. For each: bump the pin, run `gate:all`, add `.gate-snapshots/` to `.gitignore`, then set `GATE_SNAPSHOT_DIR` in the Vercel project and add an always-run merger step.

```
siteclinic-web · liddy-podiatry-site · jeffrystein-web · qirofit-web
adaauditreport-web · bmj-marketing · participation-effect-site
daily-rise (apps/web) · gaiarooster-web
```

### 8. CI + artifact preservation

```yaml
- name: Gates
  run: GATE_SNAPSHOT_DIR=.gate-snapshots npm run gate:all
- name: Build snapshot
  if: always()          # the point: capture failed builds too
  run: GATE_SNAPSHOT_DIR=.gate-snapshots npm run gate:snapshot
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: build-snapshot, path: .gate-snapshots/ }
```

### 9. Deferred — requires separate authorization

Site Monitor ingestion (`POST /api/internal/build-snapshot`), the `build_snapshots` table and its DDL, the diff UI, and Phase 2 typed per-route facts. None of these are in scope here.

---

## Rollback

Snapshot emission is inert without `GATE_SNAPSHOT_DIR`, so rollback is unsetting one environment variable — no code change, no redeploy of gate logic. To roll the package back entirely, re-pin a consumer to `#v0.12.0`.

---

## Known limitations

- **No history before first emission.** Nothing reconstructs the past.
- **Phase 1 is string-shaped.** `Check.detail` is human-readable prose, so it is lossless but not reliably diffable. Typed per-route facts are Phase 2.
- **`gate-dashboard-parity` composes subprocesses**, each writing its own fragment; the parity fragment records only the composition to avoid double-counting.
- **A snapshot is not a pass.** It records what was measured, including failures and gates that never ran.
- **Snapshots do not prove search visibility, AI citation, traffic, leads, or revenue.** Those are observational and belong to runtime monitoring.
