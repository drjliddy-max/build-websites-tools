// Tests for the extracted first-party page-view beacon core.
//
// The extraction contract: behavior must be indistinguishable from the
// pre-extraction inline implementations in siteclinic-web and
// adaauditreport-web (2026-07-18). The denylist snapshot test below locks
// the regex against silent drift from the hand-synced copies in
// site-monitor /api/page-view and the daily-rise lane.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKED_UA_PATTERN,
  shouldSendPageView,
  buildPageViewPayload,
  createLnHandler,
} from "../first-party-beacon.js";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const ENV_OK = {
  SITE_MONITOR_PAGE_VIEW_URL: "https://ingest.example/api/page-view",
  AI_LOG_SHARED_SECRET: "test-secret",
};

function lnRequest(body: unknown, userAgent: string | null = CHROME_UA): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userAgent) headers["user-agent"] = userAgent;
  return new Request("https://example.com/api/ln", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("BLOCKED_UA_PATTERN (denylist snapshot)", () => {
  it("matches the hand-synced denylist exactly (drift guard)", () => {
    assert.equal(
      BLOCKED_UA_PATTERN.source,
      "bot|spider|crawl|lighthouse|pagespeed|headlesschrome|prerender|wget|curl|python|slurp|mediapartners|adsbot|ahref|semrush|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|bingbot|yandex|baidu|duckduckbot|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|pinterest|screaming.?frog",
    );
    assert.equal(BLOCKED_UA_PATTERN.flags, "i");
  });
});

describe("shouldSendPageView", () => {
  it("allows a normal browser UA on a production host", () => {
    assert.equal(shouldSendPageView({ userAgent: CHROME_UA, hostname: "siteclinic.io" }), true);
  });

  it("blocks bot and tool user agents", () => {
    for (const ua of ["GPTBot/1.0", "curl/8.4.0", "Chrome-Lighthouse", "ClaudeBot", "Screaming Frog SEO Spider"]) {
      assert.equal(shouldSendPageView({ userAgent: ua, hostname: "siteclinic.io" }), false, ua);
    }
  });

  it("blocks empty or missing user agents", () => {
    assert.equal(shouldSendPageView({ userAgent: "", hostname: "siteclinic.io" }), false);
    assert.equal(shouldSendPageView({ userAgent: undefined, hostname: "siteclinic.io" }), false);
  });

  it("blocks Vercel preview hosts", () => {
    assert.equal(
      shouldSendPageView({ userAgent: CHROME_UA, hostname: "my-branch-preview.vercel.app" }),
      false,
    );
  });
});

describe("buildPageViewPayload", () => {
  it("builds the expected wire shape", () => {
    assert.deepEqual(
      buildPageViewPayload({ hostname: "siteclinic.io", pathname: "/pricing", referrer: "https://google.com/" }),
      { domain: "siteclinic.io", path: "/pricing", referrer: "https://google.com/" },
    );
  });

  it("normalizes an empty referrer to null (matches document.referrer || null)", () => {
    assert.deepEqual(
      buildPageViewPayload({ hostname: "siteclinic.io", pathname: "/", referrer: "" }),
      { domain: "siteclinic.io", path: "/", referrer: null },
    );
  });
});

describe("createLnHandler", () => {
  it("requires a non-empty ownHosts", () => {
    assert.throws(() => createLnHandler({ ownHosts: [] }), /ownHosts is required/);
    // @ts-expect-error deliberate misuse
    assert.throws(() => createLnHandler({}), /ownHosts is required/);
  });

  it("returns 503 with the named gap when env is missing (UNKNOWN over false)", async () => {
    const handler = createLnHandler({ ownHosts: ["example.com"], getEnv: () => ({}) });
    const res = await handler(lnRequest({ domain: "example.com", path: "/" }));
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.deepEqual(json, {
      accepted: 0,
      rejected: 0,
      error: "SITE_MONITOR_PAGE_VIEW_URL and AI_LOG_SHARED_SECRET must be configured.",
    });
  });

  it("reads env per request, not at factory time (config resolution)", async () => {
    let env: Record<string, string> = {};
    const calls: unknown[] = [];
    const handler = createLnHandler({
      ownHosts: ["example.com"],
      getEnv: () => env,
      fetchImpl: (async (...args: unknown[]) => {
        calls.push(args);
        return Response.json({ accepted: 1 }, { status: 200 });
      }) as typeof fetch,
    });
    assert.equal((await handler(lnRequest({ domain: "example.com", path: "/" }))).status, 503);
    env = { ...ENV_OK };
    assert.equal((await handler(lnRequest({ domain: "example.com", path: "/" }))).status, 200);
    assert.equal(calls.length, 1);
  });

  it("returns 400 on invalid JSON", async () => {
    const handler = createLnHandler({ ownHosts: ["example.com"], getEnv: () => ENV_OK });
    const res = await handler(lnRequest("not-json{"));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Body is not valid JSON." });
  });

  it("skips (200, not error) for foreign domains, bad paths, missing UA, bot UA", async () => {
    const handler = createLnHandler({ ownHosts: ["example.com", "www.example.com"], getEnv: () => ENV_OK });
    const cases: Array<[unknown, string | null]> = [
      [{ domain: "evil.com", path: "/" }, CHROME_UA],
      [{ domain: "example.com", path: "no-slash" }, CHROME_UA],
      [{ domain: "example.com", path: "/" }, null],
      [{ domain: "example.com", path: "/" }, "GPTBot/1.0"],
    ];
    for (const [body, ua] of cases) {
      const res = await handler(lnRequest(body, ua));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { accepted: 0, rejected: 1, skipped: true });
    }
  });

  it("forwards a valid view upstream with the shared-secret header and returns the upstream body/status", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const handler = createLnHandler({
      ownHosts: ["example.com"],
      getEnv: () => ENV_OK,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.url = url;
        seen.init = init;
        return Response.json({ accepted: 1, rejected: 0 }, { status: 200 });
      }) as unknown as typeof fetch,
    });
    const res = await handler(
      lnRequest({ domain: "Example.COM ", path: " /pricing ", referrer: "  https://google.com/  " }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { accepted: 1, rejected: 0 });
    assert.equal(seen.url, ENV_OK.SITE_MONITOR_PAGE_VIEW_URL);
    const headers = seen.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-secret");
    assert.equal(headers["Content-Type"], "application/json");
    const payload = JSON.parse(String(seen.init?.body));
    assert.deepEqual(payload, {
      domain: "example.com",
      path: "/pricing",
      referrer: "https://google.com/",
      userAgent: CHROME_UA,
    });
  });

  it("truncates path to 500, referrer to 500, userAgent to 1024", async () => {
    const seen: { init?: RequestInit } = {};
    const handler = createLnHandler({
      ownHosts: ["example.com"],
      getEnv: () => ENV_OK,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen.init = init;
        return Response.json({}, { status: 200 });
      }) as unknown as typeof fetch,
    });
    const longUa = `Mozilla/5.0 ${"x".repeat(2000)}`;
    await handler(
      lnRequest(
        { domain: "example.com", path: `/${"p".repeat(600)}`, referrer: `https://r.example/${"r".repeat(600)}` },
        longUa,
      ),
    );
    const payload = JSON.parse(String(seen.init?.body));
    assert.equal(payload.path.length, 500);
    assert.equal(payload.referrer.length, 500);
    assert.equal(payload.userAgent.length, 1024);
  });

  it("normalizes a whitespace-only referrer to null", async () => {
    const seen: { init?: RequestInit } = {};
    const handler = createLnHandler({
      ownHosts: ["example.com"],
      getEnv: () => ENV_OK,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen.init = init;
        return Response.json({}, { status: 200 });
      }) as unknown as typeof fetch,
    });
    await handler(lnRequest({ domain: "example.com", path: "/", referrer: "   " }));
    assert.equal(JSON.parse(String(seen.init?.body)).referrer, null);
  });

  it("returns 502 with the error message when upstream is unreachable", async () => {
    const handler = createLnHandler({
      ownHosts: ["example.com"],
      getEnv: () => ENV_OK,
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const res = await handler(lnRequest({ domain: "example.com", path: "/" }));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {
      error: "Upstream page-view ingest unreachable: connect ECONNREFUSED",
    });
  });

  it("proxies non-200 upstream statuses and tolerates non-JSON upstream bodies", async () => {
    const handler = createLnHandler({
      ownHosts: ["example.com"],
      getEnv: () => ENV_OK,
      fetchImpl: (async () => new Response("not json", { status: 401 })) as unknown as typeof fetch,
    });
    const res = await handler(lnRequest({ domain: "example.com", path: "/" }));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {});
  });

  it("honors consumer-specific ownHosts (www vs apex)", async () => {
    const handler = createLnHandler({
      ownHosts: ["adaauditreport.com", "www.adaauditreport.com"],
      getEnv: () => ENV_OK,
      fetchImpl: (async () => Response.json({ accepted: 1 }, { status: 200 })) as unknown as typeof fetch,
    });
    assert.equal(
      (await handler(lnRequest({ domain: "www.adaauditreport.com", path: "/" }))).status,
      200,
    );
    const skipped = await (await handler(lnRequest({ domain: "siteclinic.io", path: "/" }))).json();
    assert.deepEqual(skipped, { accepted: 0, rejected: 1, skipped: true });
  });
});
