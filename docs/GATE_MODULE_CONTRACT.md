# Gate module contract

Every file matching `src/gate-*.ts` has **two roles at once**, and the contract
below exists because those roles conflict.

1. **CLI.** `bin/gate-<name>.mjs` calls `runGate()` in `bin/_run.mjs`, which
   **spawns** the `.ts` file as a child process
   (`spawnSync(node, ["--import", tsxLoader, scriptPath])`). It is a subprocess,
   not an import: `process.argv[1]` inside the gate is the gate's own path.
2. **Library.** The test suite imports the module to exercise its exported policy
   helpers without running a scan. `gate-dashboard-parity` also spawns its four
   composed leaves the same way `_run.mjs` does.

## The invariant

> **Importing a gate module must have no observable side effects.**
>
> It must not read `gate.config.json`, launch a server, scan routes, write files,
> call an external service, or terminate the process.

## Why it is load-bearing, not stylistic

A module that calls `main()` at top level runs the whole gate the instant anything
imports it. The failure is not subtle, but it is *self-concealing*: the module
becomes untestable, so no test file is written, so nothing ever reports the gap.

`gate-ada.ts` demonstrated exactly this. It self-executed from the beginning and
was the **only gate in the package with no test file**; writing one was
impossible. The missing tests were a symptom of the defect, and the defect hid
the symptom. Repairing it (v0.27.0) is what allowed `src/__tests__/gate-ada.test.ts`
to exist at all.

## Canonical pattern

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

// ... gate implementation, exported helpers ...

const invokedDirectly =
  !!process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
```

Both sides are normalised before comparison (`path.resolve` against
`fileURLToPath`), and a missing `argv[1]` is rejected explicitly.

Anything the tests need must be `export`ed. Keep the exported surface a **pure
policy helper** where possible: a function that takes already-gathered state and
returns a verdict, with no I/O. `browserModeRefusal` in `gate-ada.ts` is the
reference shape: it is testable precisely because it does not need a browser.

## The second idiom in the tree

Four modules (`gate-ai-instrumentation.ts`,
`gate-ai-instrumentation-source.ts`, `gate-conversion-instrumentation-source.ts`
and `gate-sitemap-source.ts`) use an older spelling:

```ts
const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");
```

It satisfies the invariant under normal test and CLI conditions, so it is not a
bug in practice today and is **not** scheduled for a flag-day migration. Two
edges are weaker than the canonical form, and new code should not copy it:

- **`process.argv[1]` undefined** (for example `node -e 'import(...)'`) makes
  `endsWith("")` return `true`, so the module self-executes. The canonical form
  rejects this via `!!process.argv[1]`. This is also why the enforcement test
  imports through a real importer **file** rather than `node -e`: `-e` would trip
  this edge and produce a misleading failure.
- **`` `file://${path}` ``** is string interpolation, not URL encoding. Paths
  containing spaces or non-ASCII characters do not round-trip; the `endsWith`
  clause is what rescues it. `fileURLToPath` handles this correctly.

The enforcement test asserts the **outcome**, not the idiom, so both spellings
pass and the tree can converge incrementally.

## Enforcement

`src/__tests__/gate-import-safety.test.ts` enumerates every `src/gate-*.ts`,
imports each in a child process, and requires a clean exit.

It carries `KNOWN_SELF_EXECUTING`, a **self-cleaning** exception set: a listed
module must *still* fail. Fix a module and leave it listed, and the suite goes red
telling you to delete the entry. An exception therefore cannot quietly become
permanent.

**Current exception: `gate-seo.ts`**: no guard of either idiom, self-executes on
import. Pre-existing; classified 2026-08-11 during the `gate-ada` repair and
deliberately not fixed in that lane, to keep an unrelated production gate out of a
scoped change. It is, predictably, the only remaining gate with no unit-test file.
Repair is one guard block plus deleting its entry from the set.

## When adding a gate

The checklist in `CLAUDE.md` applies. In addition:

1. Guard `main()` with the canonical pattern above.
2. Export the policy helper the tests will call.
3. Add `src/__tests__/gate-<name>.test.ts`.
4. `gate-import-safety` picks the new module up automatically from the glob. If it
   fails, the guard is missing. Do **not** add the module to
   `KNOWN_SELF_EXECUTING` to make it pass. That set is for tracked pre-existing
   debt, not new code.
