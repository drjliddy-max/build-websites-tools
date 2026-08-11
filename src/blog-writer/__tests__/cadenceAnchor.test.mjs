// FND-0008 / RMD-0007 (operator option (a)): explicit cadence_anchor re-basing.
//
// The derived anchor (2026-08-08, a Saturday) produced a lattice the Tue/Thu
// dispatcher can never reach. schedule.cadence_anchor re-bases the lattice as
// reviewed consumer DATA. These tests pin the two fail-closed rules and the
// exact production scenario (re-base to Thu 2026-08-13 -> Thursday lattice).
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveCadenceAnchor, isGovernedTargetDate, addDays } from "../cadence.js";

const HISTORY = { published: [{ target_date: "2026-07-25" }, { target_date: "2026-08-08" }] };

test("without an explicit anchor, behavior is unchanged (derived from history)", () => {
  assert.equal(resolveCadenceAnchor(HISTORY), "2026-08-08");
  assert.equal(resolveCadenceAnchor({ published: [] }), null);
});

test("explicit anchor re-bases the lattice forward (the production 2026-08-13 scenario)", () => {
  const schedule = { schedule: { cadence_anchor: "2026-08-13" }, ...HISTORY };
  const anchor = resolveCadenceAnchor(schedule);
  assert.equal(anchor, "2026-08-13");
  assert.equal(isGovernedTargetDate(anchor, "2026-08-13"), true, "activation day is on-lattice");
  assert.equal(isGovernedTargetDate(anchor, "2026-08-27"), true, "next Thursday slot is on-lattice");
  assert.equal(isGovernedTargetDate(anchor, "2026-08-22"), false, "the old unreachable Saturday slot is OFF the re-based lattice");
  assert.equal(addDays(anchor, 14), "2026-08-27");
});

test("explicit anchor equal to derived history is accepted (no-op re-base)", () => {
  assert.equal(resolveCadenceAnchor({ schedule: { cadence_anchor: "2026-08-08" }, ...HISTORY }), "2026-08-08");
});

test("explicit anchor works for a lane with no history (first-publication lattice)", () => {
  assert.equal(resolveCadenceAnchor({ schedule: { cadence_anchor: "2026-08-13" }, published: [] }), "2026-08-13");
});

test("NEGATIVE: a backdated explicit anchor is refused (may not rewrite history)", () => {
  assert.throws(
    () => resolveCadenceAnchor({ schedule: { cadence_anchor: "2026-08-01" }, ...HISTORY }),
    /earlier than the latest real publication 2026-08-08/,
  );
});

test("NEGATIVE: an invalid explicit anchor throws rather than being silently ignored", () => {
  for (const bad of ["13-08-2026", "2026/08/13", "soon", 20260813, ""]) {
    assert.throws(
      () => resolveCadenceAnchor({ schedule: { cadence_anchor: bad }, ...HISTORY }),
      /Invalid cadence_anchor/,
      `should refuse ${JSON.stringify(bad)}`,
    );
  }
});
