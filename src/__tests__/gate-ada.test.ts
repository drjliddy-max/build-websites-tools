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
import { readFileSync } from "node:fs";
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

describe("refusal cleanup contract", () => {
  // Source assertion rather than a live run: reaching the refusal branch for real
  // requires an environment with no Chromium, which a developer machine cannot
  // reach by accident (same reason the tests above target the helper). The leak is
  // structural, so the structure is what gets asserted.
  //
  // The bug this pins: ensureBaseUrlReady() starts a dev server and the only
  // stopServer() call lives in main()'s finally. process.exit() does not run
  // finally blocks, so exiting inside the try orphans that server. Every consumer
  // sets launchCommand, so this would have leaked on exactly the builds the
  // refusal exists to stop.
  const rawSource = readFileSync(new URL("../gate-ada.ts", import.meta.url), "utf8");
  // Strip comments before asserting: this file explains WHY the branch must not
  // call process.exit, and that prose would otherwise match the very pattern the
  // assertion forbids. Assert on code, never on the commentary about the code.
  const source = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("the refusal branch does not process.exit inside the try", () => {
    const branch = source.slice(
      source.indexOf("const refusal = browserModeRefusal("),
      source.indexOf("if (scanMode === \"html-snapshot\")"),
    );
    assert.ok(branch.length > 0, "refusal branch not found; update this test");
    assert.ok(
      !/process\.exit\(/.test(branch),
      "refusal branch calls process.exit(), which skips the finally that stops the dev server",
    );
    assert.match(branch, /process\.exitCode\s*=\s*1/, "refusal must still fail the build");
    assert.match(branch, /\breturn\b/, "refusal must return so finally runs");
  });

  it("main still stops the server in a finally", () => {
    assert.match(
      source,
      /finally\s*\{\s*await stopServer\(\);/,
      "the finally that stops the dev server must survive",
    );
  });
});

/*
 * launchChromiumWithFallback: use the machine's installed Chrome when Playwright's
 * own download is absent.
 *
 * Context (2026-11-03, Alder & Stone acceptance build): on a developer Mac with
 * Google Chrome installed but no `npx playwright install`, `chromium.launch()`
 * threw "Executable doesn't exist" and gate:ada silently fell back to html-snapshot
 * mode (no color-contrast), exactly the weaker-than-local result described above,
 * even though a perfectly good browser was present. The fallback order is now:
 * Playwright's bundled Chromium, then the installed Chrome channel, then (and only
 * then) the snapshot downgrade. Cloud images with neither are unchanged.
 */
import { launchChromiumWithFallback } from "../gate-ada";

type Launch = (opts?: { channel?: string }) => Promise<never>;
const fakeBrowser = (tag: string) => ({ tag }) as never;

describe("launchChromiumWithFallback", () => {
  it("uses the bundled Chromium when it launches, without touching Chrome", async () => {
    const calls: Array<string | undefined> = [];
    const launcher = {
      launch: (async (opts?: { channel?: string }) => {
        calls.push(opts?.channel);
        return fakeBrowser("bundled");
      }) as Launch,
    };
    const r = await launchChromiumWithFallback(launcher);
    assert.equal(r.via, "bundled");
    assert.deepEqual(calls, [undefined]);
  });

  it("falls back to the installed Chrome channel when the bundled browser is missing", async () => {
    const calls: Array<string | undefined> = [];
    const launcher = {
      launch: (async (opts?: { channel?: string }) => {
        calls.push(opts?.channel);
        if (!opts?.channel) throw new Error("Executable doesn't exist at /x/chromium");
        return fakeBrowser("chrome");
      }) as Launch,
    };
    const r = await launchChromiumWithFallback(launcher);
    assert.equal(r.via, "installed-chrome");
    assert.deepEqual(calls, [undefined, "chrome"]);
  });

  it("reports every failure, and no browser, when neither launches (cloud image: unchanged)", async () => {
    const launcher = {
      launch: (async (opts?: { channel?: string }) => {
        throw new Error(opts?.channel ? "chrome not installed" : "bundled missing");
      }) as Launch,
    };
    const r = await launchChromiumWithFallback(launcher);
    assert.equal(r.browser, null);
    assert.equal(r.via, null);
    assert.equal(r.errors.length, 2);
    assert.match(r.errors.join("\n"), /bundled missing/);
    assert.match(r.errors.join("\n"), /chrome not installed/);
  });
});
