# Consumer handoff: build-websites-tools v0.12.0 (PROPOSED, NOT YET PUBLISHED)

**Status at time of writing: `READY_FOR_REVIEW`. Nothing is pushed, merged, or tagged.**
Do not treat this document as evidence that the version exists.

| Field | Value |
|---|---|
| Proposed version | `0.12.0` |
| Proposed tag | `v0.12.0` |
| Tag commit SHA | **not yet created**; would be the merge commit of `feat/conversion-contract-c1-fail-closed` on `main` |
| Reviewed branch HEAD | `bcf9bd0f01eee412986802d5ec308f561899661a` |
| Base | `b4b0c127c42b0cf067c24788a7552ccca61bf6d2` (= `v0.11.3` = `origin/main`) |
| Rollback version | **`v0.11.3`**; a consumer that hits trouble reverts its dependency to `github:drjliddy-max/build-websites-tools#v0.11.3` and reinstalls |

## What changed

### 1. Ambiguous GA4 configuration now REFUSES instead of choosing

`resolveMeasurementId(env, keys)` replaces silent first-populated-key-wins.

| Configuration | Result | `/api/track` behaviour |
|---|---|---|
| No declared key populated | `MISSING` | **503**, names the expected keys |
| Exactly one populated | `VALID` | dispatch |
| Several populated, equal after trim | `VALID` (`duplicate: true`) | dispatch once |
| Several populated, values differ | **`CONFLICT`** | **503**, names the conflicting KEYS, never their values, **sends nothing** |

Empty and whitespace-only values are absent. Surrounding whitespace is trimmed; the
identifier is not otherwise rewritten. The `CONFLICT` result object carries key names only,
so a caller cannot leak an id into an error string by accident.

**Why.** Every consumer declares two keys. Until now a stale `GA4_MEASUREMENT_ID` silently
outranked the correct public id and sent conversions to a different property, while the
relay returned `{ok:true}` and GA4 returned `204`. No status code could reveal it.

### 2. Non-finite numeric event parameters are dropped

`NaN`, `Infinity` and `-Infinity` are `typeof "number"` but `JSON.stringify` emits them as
`null`, so an unguarded numeric param reached GA4 as a null and its metric was lost with no
error. They are now omitted. `0` and `false` are preserved; they are falsy but valid.

**A malformed PARAM drops; it never costs the EVENT it belongs to.**

## Exported surface

Added: `resolveMeasurementId(env, keys)` and the `MeasurementIdResolution` type
(`VALID` | `MISSING` | `CONFLICT`).

**No existing export changed signature.** `createTrackHandler` takes the same options and
returns the same `Request -> Response` handler.

## Do consumers need code changes?

**Expected: no.** A consumer that passes `allowedEvents` and optionally
`measurementIdEnvKeys` compiles and behaves identically, *provided its deployed environment
does not populate two declared keys with different values*.

**This document does not assert that any specific consumer is compatible, including
`bmj-marketing`.** Compatibility depends on deployed environment values, which are not
inspectable from source. **Each consumer must install the artifact and verify
independently.**

## Required consumer verification (per consumer, after bumping)

```bash
npm ci
npm run typecheck
npm run build            # if defined
npm run gate:conversion-instrumentation-source
```

Then, against the deployment, confirm `/api/track` does **not** return 503 for an
allowlisted event. A 503 naming two keys means that environment populates both with
different values: set exactly one, or make them identical. **Do not work around it by
pinning back to v0.11.3 and leaving the ambiguity in place: v0.11.3 will keep silently
choosing, which is the defect.**

## Known limitations

- The package ships **no client helper**. `conversion-relay` is server-only, so it cannot
  guarantee a pre-redirect event is *delivered*. `keepalive: true` is a request to the
  browser, not a receipt. The contract pins call-site shape only.
- `VALID_SINGLE` and `VALID_EQUAL_DUPLICATE` are not distinguishable from outside the
  process; both dispatch identically.
- A `204` from GA4 still does not prove storage. Verification must terminate at the
  destination property.
- No source-level gate enforces `keepalive` across consumers yet; that is a follow-up.

## Migration notes

Bump the dependency and refresh the lockfile:

```
"build-websites-tools": "github:drjliddy-max/build-websites-tools#v0.12.0"
```

Recommended, not required by this release: declare `measurementIdEnvKeys` explicitly rather
than inheriting defaults, so the accepted key set is visible in the repository. Do **not**
add aliases "for compatibility": every additional accepted key is one more thing that can
disagree.

Canonical keys: server `GA4_MEASUREMENT_ID`, public `NEXT_PUBLIC_GA_MEASUREMENT_ID`. The
`NEXT_PUBLIC_GA4_ID` alias is opt-in per consumer and is used only by `siteclinic-web` and
`adaauditreport-web`, whose production env predates this module.
