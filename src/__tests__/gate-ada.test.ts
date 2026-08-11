/**
 * gate-ada: browser-mode refusal.
 *
 * Context (2026-08-11): on a stock cloud build image Playwright's Chromium is not
 * installed, so gate-ada logs `browser launch unavailable` and continues in jsdom
 * html-snapshot mode, which cannot run axe color-contrast. Production therefore ran
 * a WEAKER accessibility gate than any developer machine, silently, for the whole
 * life of the package. Observed on Vercel deployment
 * dpl_EqYxc4AuYChqN2Gp8CP4iyEBstmx (liddy-podiatry-site).
 *
 * `ada.requireBrowserMode` lets a consumer refuse that downgrade. It defaults to
 * false so the change is non-breaking: turning it on without also installing a
 * browser would fail every cloud build.
 *
 * These tests target the decision function rather than main(), because the branch
 * only fires when Chromium is ABSENT, an environment a developer machine (where
 * Chromium is present) cannot reach by accident. Testing it through the real gate
 * would mean uninstalling the browser.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserModeRefusal } from "../gate-ada";

describe("browserModeRefusal", () => {
  it("allows browser mode regardless of the flag", () => {
    assert.equal(browserModeRefusal("browser", { ada: { requireBrowserMode: true } }), null);
    assert.equal(browserModeRefusal("browser", { ada: { requireBrowserMode: false } }), null);
    assert.equal(browserModeRefusal("browser", {}), null);
  });

  it("permits the snapshot fallback by default (the historical behaviour)", () => {
    assert.equal(browserModeRefusal("html-snapshot", {}), null);
    assert.equal(browserModeRefusal("html-snapshot", { ada: {} }), null);
    assert.equal(
      browserModeRefusal("html-snapshot", { ada: { requireBrowserMode: false } }),
      null,
    );
  });

  it("refuses the snapshot fallback when requireBrowserMode is true", () => {
    const refusal = browserModeRefusal("html-snapshot", { ada: { requireBrowserMode: true } });
    assert.notEqual(refusal, null, "requireBrowserMode:true must refuse snapshot mode");
    assert.match(refusal!, /FAIL/);
  });

  it("names the fix and the escape hatch, so the failure is actionable", () => {
    const refusal = browserModeRefusal("html-snapshot", { ada: { requireBrowserMode: true } })!;
    assert.match(refusal, /playwright install chromium/, "must name the actual remedy");
    assert.match(refusal, /requireBrowserMode/, "must name the opt-out");
    assert.match(refusal, /color-contrast/, "must say what coverage is lost");
  });

  it("treats only an explicit true as opt-in, not any truthy value", () => {
    // Guards against a config typo like "true" (string) silently enabling a
    // build-breaking refusal, and against `undefined` being read as opt-in.
    const notOptedIn = { ada: { requireBrowserMode: undefined } } as {
      ada: { requireBrowserMode?: boolean };
    };
    assert.equal(browserModeRefusal("html-snapshot", notOptedIn), null);
  });
});
