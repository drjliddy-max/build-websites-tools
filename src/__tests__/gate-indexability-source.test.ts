/*
 * Tests for gate-indexability-source.
 *
 * The fixtures are built from the real sites that produced this gate on
 * 2026-10-07, named after them, because synthetic happy-path strings would
 * not have caught any of these:
 *
 *   - daily-rise:                 six off-sitemap routes inheriting
 *                                 `index: true` from the root layout, while
 *                                 gate.config already listed them as
 *                                 off-sitemap. The defect the gate exists for.
 *   - theparticipationeffect:     /chapter-one, a real lead page, indexable
 *                                 and sitemapped, but declared nowhere, so no
 *                                 gate ever visited it. A COVERAGE gap. It was
 *                                 first reported as unsitemapped; that was a
 *                                 measurement error (www vs non-www grep).
 *   - adaauditreport:             "/verify" declared in
 *                                 allowedOffSitemapRoutes with no bare page
 *                                 (only /verify/[leadId]). Flagging it was a
 *                                 FALSE POSITIVE during the sweep.
 *   - siteclinic:                 34 declared routes against 18 in source.
 *                                 Declared-but-absent must not be an error.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  declaresNoindex,
  evaluateSource,
  listStaticRoutes,
  readDisallowedPaths,
  resolveNoindex,
} from "../gate-indexability-source";

const temps: string[] = [];

// mkdtemp inside os.tmpdir() with an explicit join: `mkdtemp("-t name")` is a
// BSD-only spelling and produces setup failures that masquerade as verdicts.
function makeSite(spec: {
  routes?: string[];
  allowedOffSitemapRoutes?: string[];
  indexability?: Record<string, unknown>;
  /** route -> file contents, written as app/<route>/layout.tsx */
  layouts?: Record<string, string>;
  /** route -> file contents, written as app/<route>/page.tsx */
  pages?: Record<string, string>;
  robots?: string;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bwt-indexability-"));
  temps.push(dir);
  const app = path.join(dir, "src", "app");
  fs.mkdirSync(app, { recursive: true });

  for (const [route, body] of Object.entries(spec.pages ?? {})) {
    const target = route === "/" ? app : path.join(app, route.replace(/^\//, ""));
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "page.tsx"), body);
  }
  for (const [route, body] of Object.entries(spec.layouts ?? {})) {
    const target = route === "/" ? app : path.join(app, route.replace(/^\//, ""));
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "layout.tsx"), body);
  }
  if (spec.robots !== undefined) {
    const rdir = path.join(app, "robots.txt");
    fs.mkdirSync(rdir, { recursive: true });
    fs.writeFileSync(path.join(rdir, "route.ts"), spec.robots);
  }
  fs.writeFileSync(
    path.join(dir, "gate.config.json"),
    JSON.stringify({
      routes: spec.routes ?? [],
      baseUrl: "http://127.0.0.1:3000",
      allowedOffSitemapRoutes: spec.allowedOffSitemapRoutes ?? [],
      ...(spec.indexability ? { indexability: spec.indexability } : {}),
    }),
  );
  return dir;
}

const NOINDEX_LAYOUT = `export const metadata = { robots: { index: false, follow: true } };
export default function L({ children }) { return children; }`;
const INDEXABLE_LAYOUT = `export const metadata = { robots: { index: true, follow: true } };
export default function L({ children }) { return children; }`;
const PAGE = `export default function P() { return null; }`;

const check = (dir: string, name: string) => {
  const { checks } = evaluateSource({ cwd: dir });
  const found = checks.find((c) => c.name === name);
  assert.ok(found, `expected a check named ${name}`);
  return found;
};

afterEach(() => {
  while (temps.length) {
    const d = temps.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("noindex detection", () => {
  it("recognises every form the portfolio actually uses", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bwt-noindex-"));
    temps.push(dir);
    const write = (n: string, body: string) => {
      const f = path.join(dir, n);
      fs.writeFileSync(f, body);
      return f;
    };
    assert.equal(
      declaresNoindex(write("a.tsx", "export const metadata = { robots: { index: false } };")),
      true,
      "Metadata object form",
    );
    assert.equal(
      declaresNoindex(
        write("b.tsx", "export const metadata = {\n robots: {\n  index: false,\n  follow: true,\n },\n};"),
      ),
      true,
      "multiline form - daily-rise's actual shape",
    );
    assert.equal(
      declaresNoindex(write("c.tsx", 'export const metadata = { robots: "noindex, follow" };')),
      true,
      "string form",
    );
    assert.equal(
      declaresNoindex(write("d.tsx", '<meta name="robots" content="noindex" />')),
      true,
      "hand-written tag",
    );
    assert.equal(
      declaresNoindex(write("e.tsx", "export const metadata = { robots: { index: true } };")),
      false,
      "indexable must not read as noindex",
    );
    assert.equal(declaresNoindex(path.join(dir, "nope.tsx")), false, "missing file");
  });
});

describe("route enumeration", () => {
  it("counts only directories that hold a page, and flattens route groups", () => {
    const dir = makeSite({
      pages: { "/": PAGE, "/about": PAGE, "/(marketing)/pricing": PAGE },
      // a directory with a layout but no page is not a route
      layouts: { "/shell": INDEXABLE_LAYOUT },
    });
    const routes = listStaticRoutes(path.join(dir, "src", "app"));
    assert.deepEqual(routes, ["/", "/about", "/pricing"]);
  });

  it("adaauditreport: a config entry whose bare route has no page is not evaluated", () => {
    // Real shape: src/app/verify/[leadId]/page.tsx exists, src/app/verify/page.tsx does not.
    const dir = makeSite({
      routes: ["/"],
      allowedOffSitemapRoutes: ["/verify"],
      pages: { "/": PAGE, "/verify/[leadId]": PAGE },
    });
    const routes = listStaticRoutes(path.join(dir, "src", "app"));
    assert.ok(!routes.includes("/verify"), "bare /verify must not be discovered");
    // and therefore the gate must not fail on it
    assert.equal(check(dir, "offSitemapNoindexed").pass, true);
  });
});

describe("metadata inheritance", () => {
  it("inherits noindex from an ancestor layout", () => {
    const dir = makeSite({
      pages: { "/auth/login": PAGE },
      layouts: { "/auth": NOINDEX_LAYOUT },
    });
    const res = resolveNoindex(path.join(dir, "src", "app"), "/auth/login");
    assert.equal(res.noindex, true);
    assert.match(res.via ?? "", /auth[\\/]layout\.tsx/);
  });

  it("does not let an ancestor PAGE leak its noindex to children", () => {
    const dir = makeSite({
      pages: { "/dash": `export const metadata = { robots: { index: false } };\n${PAGE}`, "/dash/kid": PAGE },
    });
    const app = path.join(dir, "src", "app");
    assert.equal(resolveNoindex(app, "/dash").noindex, true, "the page governs itself");
    assert.equal(resolveNoindex(app, "/dash/kid").noindex, false, "but not its child");
  });
});

describe("the daily-rise defect", () => {
  it("FAILS when an off-sitemap route inherits index:true from the root layout", () => {
    const dir = makeSite({
      routes: ["/"],
      allowedOffSitemapRoutes: ["/settings", "/share"],
      layouts: { "/": INDEXABLE_LAYOUT },
      pages: { "/": PAGE, "/settings": PAGE, "/share": PAGE },
    });
    const c = check(dir, "offSitemapNoindexed");
    assert.equal(c.pass, false);
    assert.match(c.detail, /\/settings/);
    assert.match(c.detail, /\/share/);
  });

  it("PASSES once each off-sitemap route declares noindex", () => {
    const dir = makeSite({
      routes: ["/"],
      allowedOffSitemapRoutes: ["/settings", "/share"],
      layouts: { "/": INDEXABLE_LAYOUT, "/settings": NOINDEX_LAYOUT, "/share": NOINDEX_LAYOUT },
      pages: { "/": PAGE, "/settings": PAGE, "/share": PAGE },
    });
    assert.equal(check(dir, "offSitemapNoindexed").pass, true);
    assert.equal(evaluateSource({ cwd: dir }).pass, true);
  });
});

describe("the theparticipationeffect defect", () => {
  it("FAILS on a route declared in neither list", () => {
    const dir = makeSite({
      routes: ["/"],
      pages: { "/": PAGE, "/chapter-one": PAGE },
    });
    const c = check(dir, "classified");
    assert.equal(c.pass, false);
    assert.match(c.detail, /\/chapter-one/);
  });

  it("passes once the route is declared public", () => {
    const dir = makeSite({
      routes: ["/", "/chapter-one"],
      pages: { "/": PAGE, "/chapter-one": PAGE },
    });
    assert.equal(check(dir, "classified").pass, true);
  });

  it("honours allowUnclassified as a recorded, staged exemption", () => {
    const dir = makeSite({
      routes: ["/"],
      pages: { "/": PAGE, "/chapter-one": PAGE },
      indexability: { allowUnclassified: ["/chapter-one"] },
    });
    assert.equal(check(dir, "classified").pass, true);
  });
});

describe("a sitemapped route must stay indexable", () => {
  it("FAILS when a declared public route carries noindex", () => {
    const dir = makeSite({
      routes: ["/", "/services"],
      layouts: { "/services": NOINDEX_LAYOUT },
      pages: { "/": PAGE, "/services": PAGE },
    });
    const c = check(dir, "publicRoutesIndexable");
    assert.equal(c.pass, false);
    assert.match(c.detail, /\/services/);
  });
});

describe("Disallow plus noindex is self-defeating", () => {
  it("FAILS when a noindexed rendering route sits under a robots.txt Disallow", () => {
    const dir = makeSite({
      routes: ["/"],
      allowedOffSitemapRoutes: ["/auth/login"],
      layouts: { "/auth": NOINDEX_LAYOUT },
      pages: { "/": PAGE, "/auth/login": PAGE },
      robots: 'const DISALLOWED_PATHS = ["/api/", "/auth/"];',
    });
    const c = check(dir, "noDisallowPlusNoindex");
    assert.equal(c.pass, false, "the Disallow prevents the noindex being read");
    assert.match(c.detail, /\/auth\/login/);
  });

  it("PASSES once /auth/ is removed and only /api/ stays disallowed", () => {
    const dir = makeSite({
      routes: ["/"],
      allowedOffSitemapRoutes: ["/auth/login"],
      layouts: { "/auth": NOINDEX_LAYOUT },
      pages: { "/": PAGE, "/auth/login": PAGE },
      robots: 'const DISALLOWED_PATHS = ["/api/"];',
    });
    assert.equal(check(dir, "noDisallowPlusNoindex").pass, true);
    assert.equal(evaluateSource({ cwd: dir }).pass, true);
  });

  it("reads Disallow from a literal robots.txt as well as a TS array", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bwt-robots-"));
    temps.push(dir);
    const f = path.join(dir, "robots.txt");
    fs.writeFileSync(f, "User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\n");
    assert.deepEqual(readDisallowedPaths(f).sort(), ["/api/", "/auth/"]);
  });

  it("ignores a bare 'Disallow: /' and unrelated string arrays", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bwt-robots2-"));
    temps.push(dir);
    const f = path.join(dir, "route.ts");
    fs.writeFileSync(
      f,
      'const CITATION_BOTS = ["/not-a-path-but-looks-like-one"];\nconst DISALLOWED_PATHS = ["/api/"];\n',
    );
    assert.deepEqual(readDisallowedPaths(f), ["/api/"]);
  });
});

describe("siteclinic: declared-but-absent is not an error", () => {
  it("does not fail when gate.config declares more routes than source ships", () => {
    const dir = makeSite({
      // 4 declared, only 2 exist in source (the rest are content URLs)
      routes: ["/", "/about", "/blog/post-a", "/blog/post-b"],
      pages: { "/": PAGE, "/about": PAGE },
    });
    const result = evaluateSource({ cwd: dir });
    assert.equal(result.pass, true);
    assert.equal(result.routes.length, 2, "only real routes are judged");
  });
});

describe("missing scaffolding fails loudly rather than passing vacuously", () => {
  it("fails when there is no app directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bwt-noapp-"));
    temps.push(dir);
    fs.writeFileSync(path.join(dir, "gate.config.json"), JSON.stringify({ routes: ["/"] }));
    const result = evaluateSource({ cwd: dir });
    assert.equal(result.pass, false);
    assert.equal(result.checks[0].name, "appDirectory");
  });

  it("fails when there is no gate.config.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bwt-nocfg-"));
    temps.push(dir);
    fs.mkdirSync(path.join(dir, "src", "app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "app", "page.tsx"), PAGE);
    const result = evaluateSource({ cwd: dir });
    assert.equal(result.pass, false);
    assert.equal(result.checks[0].name, "gateConfig");
  });
});
