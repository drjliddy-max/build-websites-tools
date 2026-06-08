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
import axe from "axe-core";
import AxeBuilder from "@axe-core/playwright";
import { JSDOM } from "jsdom";
import { chromium, type Browser, type Page } from "playwright";
import { ensureBaseUrlReady } from "./ensure-base-url";
import { loadGateConfig } from "./load-config";

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

    if (totalBlocking > 0) {
      console.error(`\ngate:ada  FAIL: ${totalBlocking} blocking violation(s)`);
      process.exit(1);
    }
    console.log("\ngate:ada  PASS");
  } finally {
    await stopServer();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
