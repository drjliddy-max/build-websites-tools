/*
 * Unit tests for the gate:dashboard-parity policy (Phase 3, Option A).
 *
 * The meta-gate composes the existing readiness gates by spawning them; that
 * orchestration is exercised end-to-end by each composed gate's own tests +
 * CI. Here we lock the POLICY: the required-surface set (so a surface can't be
 * silently dropped) and the aggregation (so a missing surface fails the build
 * with a named gap).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_READINESS_GATES,
  aggregateGateResults,
} from "../gate-dashboard-parity";

test("requires exactly the four board-readiness surfaces (no silent drop)", () => {
  const scripts = REQUIRED_READINESS_GATES.map((g) => g.script).sort();
  assert.deepEqual(scripts, [
    "gate-ada",
    "gate-ai-instrumentation-source",
    "gate-conversion-instrumentation-source",
    "gate-seo",
  ]);
});

test("aggregate PASSES only when every required gate passes", () => {
  const allOk = REQUIRED_READINESS_GATES.map((g) => ({ label: g.label, ok: true }));
  const agg = aggregateGateResults(allOk);
  assert.equal(agg.ok, true);
  assert.deepEqual(agg.failed, []);
});

test("aggregate FAILS and names the gap when a readiness surface is missing", () => {
  // Simulate gate:ada failing (a site missing accessibility readiness).
  const results = REQUIRED_READINESS_GATES.map((g, i) => ({
    label: g.label,
    ok: i !== 0,
  }));
  const agg = aggregateGateResults(results);
  assert.equal(agg.ok, false);
  assert.equal(agg.failed.length, 1);
  assert.match(agg.failed[0], /gate:ada/);
});

test("aggregate reports ALL missing surfaces, not just the first", () => {
  const results = REQUIRED_READINESS_GATES.map((g) => ({ label: g.label, ok: false }));
  const agg = aggregateGateResults(results);
  assert.equal(agg.ok, false);
  assert.equal(agg.failed.length, REQUIRED_READINESS_GATES.length);
});
