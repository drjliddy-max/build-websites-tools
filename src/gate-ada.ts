/*
 * gate:ada: WCAG 2.1 AA enforcement gate.
 *
 * Runs axe-core (the same engine ada-audit-tool sells as a $49 product)
 * against every route in gate.config.json. Fails on ANY critical / serious /
 * moderate violation. Direct dogfooding: every owned portfolio site is audited
 * by the same scanner customers will pay for.
 *
 * Reads `gate.config.json` from the consuming site's cwd (see load-config.ts).
 * Site-agnostic: zero site-specific assumptions in this file.
 *
 * Doctrine reference: build-websites-template/03-build-standard.md §40
 * (Accessibility Baseline) + 05-qa-and-release.md §6 (mandatory checks).
 * Operator extension 2026-05-11: stricter than doctrine. Zero blocking
 * violations required, not "issues triaged."
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import AxeBuilder from "@axe-core/playwright";
import { JSDOM } from "jsdom";
import { chromium, type Browser, type Page } from "playwright";
import { ensureBaseUrlReady } from "./ensure-base-url";
import { loadGateConfig, type GateConfig } from "./load-config";

type Impact = "critical" | "serious" | "moderate" | "minor";
const BLOCKING_IMPACTS: Impact[] = ["critical", "serious", "moderate"];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const;

interface BrowserSession {
  browser: Browser;
  page: Page;
}

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;

async function createBrowserSession(): Promise<BrowserSession | null> {
  try {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    return { browser, page };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `gate:ada  browser launch unavailable, falling back to HTML snapshot mode: ${detail}`,
    );
    return null;
  }
}

async function analyzeWithBrowser(page: Page, url: string): Promise<AxeResults> {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  return new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
}

async function analyzeWithSnapshot(url: string): Promise<AxeResults> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to load ${url}: HTTP ${response.status}`);
  }

  const html = await response.text();
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url,
  });

  try {
    dom.window.eval(axe.source);

    const axeRunner = (dom.window as typeof dom.window & {
      axe?: {
        run: (context?: unknown, options?: unknown) => Promise<AxeResults>;
      };
    }).axe;

    if (!axeRunner?.run) {
      throw new Error("axe failed to initialize in JSDOM");
    }

    return await axeRunner.run(dom.window.document, {
      runOnly: {
        type: "tag",
        values: [...AXE_TAGS],
      },
      rules: {
        "color-contrast": { enabled: false },
      },
    });
  } finally {
    dom.window.close();
  }
}

/**
 * Decide whether a missing browser is a fallback or a failure.
 *
 * Split out from main() so the decision is unit-testable: the branch that matters
 * only fires when Chromium is absent, which is precisely the environment a test on
 * a developer machine (where Chromium is present) can never reach by accident.
 *
 * Returns null when the run may proceed, or the operator-facing failure message.
 */
export function browserModeRefusal(
  scanMode: "browser" | "html-snapshot",
  config: Pick<GateConfig, "ada">,
): string | null {
  if (scanMode === "browser") return null;
  if (config.ada?.requireBrowserMode !== true) return null;
  return [
    "gate:ada  FAIL: ada.requireBrowserMode is true but Chromium could not be launched.",
    "gate:ada  Refusing to fall back to html-snapshot mode, which cannot run axe color-contrast",
    "gate:ada  and would report a weaker result than a developer sees locally.",
    "gate:ada  Fix: run `npx playwright install chromium` in this project's install/build step,",
    "gate:ada  or set ada.requireBrowserMode to false to accept snapshot mode explicitly.",
  ].join("\n");
}

async function main() {
  const config = loadGateConfig();
  const { routes, baseUrl } = config;
  const stopServer = await ensureBaseUrlReady(config);

  try {
    const browserSession = await createBrowserSession();
    const scanMode = browserSession ? "browser" : "html-snapshot";

    let totalBlocking = 0;
    const perRouteResults: Array<{ route: string; blocking: number; minor: number }> = [];

    console.log(`gate:ada  mode ${scanMode}`);

    const refusal = browserModeRefusal(scanMode, config);
    if (refusal !== null) {
      console.error(refusal);
      // Set the code and return rather than exiting here: an immediate exit skips
      // the finally below, orphaning the dev server ensureBaseUrlReady() started.
      // Every consumer sets launchCommand, so that leak would be the common case
      // for exactly the builds this refusal exists to stop.
      process.exitCode = 1;
      return;
    }

    if (scanMode === "html-snapshot") {
      console.log(
        "gate:ada  html-snapshot fallback disables axe color-contrast because JSDOM does not provide canvas-backed visual layout APIs.",
      );
    }

    for (const route of routes) {
      const url = `${baseUrl}${route}`;
      process.stdout.write(`gate:ada  scanning ${url}  …`);

      try {
        const results = browserSession
          ? await analyzeWithBrowser(browserSession.page, url)
          : await analyzeWithSnapshot(url);

        const blocking = results.violations.filter((v) =>
          BLOCKING_IMPACTS.includes((v.impact as Impact) || "minor"),
        );
        const minor = results.violations.length - blocking.length;

        perRouteResults.push({ route, blocking: blocking.length, minor });
        totalBlocking += blocking.length;

        if (blocking.length > 0) {
          console.log(` ✗ ${blocking.length} blocking, ${minor} minor`);
          for (const v of blocking) {
            console.log(`    [${v.impact}] ${v.id}: ${v.help}`);
            console.log(`      ${v.helpUrl}`);
            console.log(`      affects ${v.nodes.length} node(s):`);
            for (const node of v.nodes.slice(0, 3)) {
              console.log(`        - ${node.target.join(" > ")}`);
            }
            if (v.nodes.length > 3) {
              console.log(`        … and ${v.nodes.length - 3} more`);
            }
          }
        } else if (minor > 0) {
          console.log(` ✓ no blocking (${minor} minor)`);
        } else {
          console.log(" ✓ clean");
        }
      } catch (err) {
        console.error(`\n  ✗ failed to load ${url}: ${(err as Error).message}`);
        console.error("    is the dev server running at this URL?");
        if (browserSession) {
          await browserSession.browser.close();
        }
        process.exit(1);
      }
    }

    if (browserSession) {
      await browserSession.browser.close();
    }

    console.log("");
    console.log("gate:ada  summary");
    for (const r of perRouteResults) {
      console.log(`  ${r.route}: ${r.blocking} blocking, ${r.minor} minor`);
    }

    // When the gate falls back to html-snapshot mode (Vercel and other
    // cloud builders without Chromium), the axe color-contrast rule is
    // disabled because JSDOM cannot compute rendered styles. We already
    // print a warning at the start of the run, but operators scanning
    // long build logs often see only the terminal PASS/FAIL line. Repeat
    // the disclosure there so the coverage caveat is visible without
    // scrolling. siteclinic-web commit 7bb07a6 (2026-06-08) shipped a
    // serious color-contrast violation through a green Vercel build
    // because the early warning was buried; this annotation closes that
    // loop without changing exit semantics.
    const modeSuffix =
      scanMode === "html-snapshot"
        ? "  [html-snapshot mode; color-contrast not evaluated, rerun in browser mode for full WCAG 2.1 AA coverage]"
        : "";

    if (totalBlocking > 0) {
      console.error(
        `\ngate:ada  FAIL: ${totalBlocking} blocking violation(s)${modeSuffix}`,
      );
      process.exit(1);
    }
    console.log(`\ngate:ada  PASS${modeSuffix}`);
  } finally {
    await stopServer();
  }
}

// Self-execute ONLY when invoked directly, so tests can import the policy helper
// (browserModeRefusal) without loading gate.config.json and launching a scan.
// Mirrors the guard gate-dashboard-parity.ts already uses; before this, importing
// this module ran the whole gate as a side effect.
const invokedDirectly =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
