// first-party-beacon - shared core of the cookieless first-party page-view
// lane (MASTER_VISIBILITY_MATRIX §17.3.1.2 "first-party page-view lane").
//
// Extracted 2026-07-18 from the byte-identical implementations in
// siteclinic-web and adaauditreport-web under the extract-on-third-consumer
// rule, so the bot denylist and proxy semantics have a single source
// before a third site adopts the lane.
//
// Responsibility split:
//   shared (this module) - the bot/preview send predicate, the page-view
//     payload shape, and the /api/ln proxy handler (validation, denylist,
//     truncation, upstream forwarding, honest 503 on missing config).
//   consumer - the React client component (framework-coupled), the
//     ownHosts list, route wiring (e.g. `export const dynamic`), and the
//     SITE_MONITOR_PAGE_VIEW_URL / AI_LOG_SHARED_SECRET env values.
//
// Privacy contract (do not change): cookieless, aggregate page-load
// counting only - no cookies, no identifiers, no IP forwarded (CNIL
// audience-measurement-exemption shape). Do not add identity fields.
//
// NOTE: the denylist must stay in sync with site-monitor's /api/page-view
// ingest and the daily-rise lane (both still hand-synced as of 2026-07-18).

// Same denylist as site-monitor /api/page-view. Applied client-side by
// shouldSendPageView and server-side by the /api/ln handler (the server
// check catches direct POSTs that bypass the client beacon).
export const BLOCKED_UA_PATTERN =
  /bot|spider|crawl|lighthouse|pagespeed|headlesschrome|prerender|wget|curl|python|slurp|mediapartners|adsbot|ahref|semrush|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|bingbot|yandex|baidu|duckduckbot|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|pinterest|screaming.?frog/i;

// Client-side send predicate: skip bots, empty user agents, and Vercel
// preview hosts. Mirrors the original FirstPartyBeacon component checks.
export function shouldSendPageView({ userAgent, hostname }) {
  if (!userAgent) return false;
  if (BLOCKED_UA_PATTERN.test(userAgent)) return false;
  if ((hostname || "").includes("vercel.app")) return false;
  return true;
}

// The POST /api/ln body shape. Referrer is meaningful on the first page
// load and stale on SPA navs - accepted, matches the original beacon.
export function buildPageViewPayload({ hostname, pathname, referrer }) {
  return {
    domain: hostname,
    path: pathname,
    referrer: referrer || null,
  };
}

// Build the POST /api/ln route handler. Framework-agnostic: takes a Web
// Request, returns a Web Response, so any Next.js App Router route can
// `export const POST = createLnHandler({ ownHosts: [...] })`.
//
// Per §3.1.3 layer 9 (UNKNOWN over false): missing config returns 503
// with a named gap, not a silent 200.
export function createLnHandler(options) {
  const rawHosts = options && options.ownHosts ? [...options.ownHosts] : [];
  if (rawHosts.length === 0) {
    throw new Error(
      "createLnHandler: ownHosts is required (the site's own production hostnames, e.g. ['example.com', 'www.example.com']).",
    );
  }
  const ownHosts = new Set(rawHosts.map((h) => String(h).trim().toLowerCase()));
  const fetchImpl = (options && options.fetchImpl) || ((...args) => fetch(...args));
  // Env is read per request (not at factory time) so runtime config
  // changes and tests behave like the original inline route.
  const getEnv = (options && options.getEnv) || (() => process.env);

  return async function handleLnPost(request) {
    const env = getEnv();
    const upstreamUrl = env.SITE_MONITOR_PAGE_VIEW_URL;
    const sharedSecret = env.AI_LOG_SHARED_SECRET;

    if (!upstreamUrl || !sharedSecret) {
      return jsonResponse(
        {
          accepted: 0,
          rejected: 0,
          error:
            "SITE_MONITOR_PAGE_VIEW_URL and AI_LOG_SHARED_SECRET must be configured.",
        },
        503,
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Body is not valid JSON." }, 400);
    }

    const domain = typeof body.domain === "string" ? body.domain.trim().toLowerCase() : "";
    const path = typeof body.path === "string" ? body.path.trim() : "";
    const userAgent = (request.headers.get("user-agent") || "").trim();

    // Skip (200, not error) rather than reject loudly - the beacon is
    // fire-and-forget and these are expected non-human/preview cases.
    if (!ownHosts.has(domain) || !path.startsWith("/") || !userAgent || BLOCKED_UA_PATTERN.test(userAgent)) {
      return jsonResponse({ accepted: 0, rejected: 1, skipped: true }, 200);
    }

    let upstream;
    try {
      upstream = await fetchImpl(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sharedSecret}`,
        },
        body: JSON.stringify({
          domain,
          path: path.slice(0, 500),
          referrer:
            typeof body.referrer === "string" && body.referrer.trim().length > 0
              ? body.referrer.trim().slice(0, 500)
              : null,
          userAgent: userAgent.slice(0, 1024),
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      return jsonResponse(
        { error: `Upstream page-view ingest unreachable: ${message}` },
        502,
      );
    }

    const json = await upstream.json().catch(() => ({}));
    return jsonResponse(json, upstream.status);
  };
}

function jsonResponse(body, status) {
  return Response.json(body, { status });
}
