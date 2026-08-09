// conversion-relay - shared core of the server-side GA4 conversion lane
// (MASTER_VISIBILITY_MATRIX §17.3.1.2 "Conversion Instrumentation Contract").
//
// Extracted 2026-07-31 from nine near-identical copies of
// src/app/api/track/{route,logic}.ts, under the same extract-on-third-consumer
// rule that produced first-party-beacon. Those copies had drifted into a
// single shared defect class, so the fix belongs here once rather than nine
// times.
//
// WHAT THIS CORRECTS (audit trail: _audit-vault F-20260731-02/-03/-05)
// ====================================================================
//   1. Double delivery. The prior shape fired client gtag AND posted here,
//      with no consent check between them. A consenting visitor's single
//      click landed in GA4 twice, under two different client_ids (the _ga
//      cookie vs a relay-minted one), so one click read as two events and
//      two users. The corrected standard is SERVER-ONLY: the client posts
//      here and does not fire a gtag event for the same click.
//
//   2. Sessionless events. The prior payload was {client_id, events} with no
//      session_id and no engagement_time_msec. GA4 answers 204 either way -
//      accepted is not attributed - so the events landed attached to no
//      session and conversions could never be traced to a landing page,
//      source, or campaign. Both params are now mandatory and live in the
//      EVENT params (not top level), which is where GA4 reads them.
//
//   3. Split identity. For a consenting visitor GA4 already holds an identity
//      in the _ga cookie and a session in _ga_<CONTAINER>. This module reads
//      both so server-sent events join the visitor's real session instead of
//      forking a parallel one. Only when there is no GA cookie - i.e. the
//      visitor has not consented - does it mint and persist a first-party id.
//
// Responsibility split, mirroring first-party-beacon:
//   shared (this module) - cookie parsing, identity resolution, payload shape,
//     event allowlisting, param sanitisation, and the POST handler.
//   consumer - the client call site, the site's own event allowlist, route
//     wiring (`export const dynamic`), and the GA4_MEASUREMENT_ID /
//     GA4_API_SECRET env values.
//
// Privacy contract: the first-party fallback id is an aggregate measurement
// identifier, not a profile. When the visitor has not consented the payload
// declares consent DENIED for ad_user_data and ad_personalization, so the
// event is counted but never used for advertising personalisation. Do not add
// identity fields, and do not forward the raw IP when consent is absent.

const MP_ENDPOINT = "https://www.google-analytics.com/mp/collect";

// GA4 requires engagement_time_msec for a session to count as engaged. A
// conversion click is a real engagement, so a nonzero default is correct;
// callers may pass the measured value.
export const DEFAULT_ENGAGEMENT_TIME_MSEC = 100;

/** Parse a Cookie header into a plain object. Exported for tests. */
export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const segment of String(cookieHeader).split(";")) {
    const idx = segment.indexOf("=");
    if (idx === -1) continue;
    const key = segment.slice(0, idx).trim();
    const value = segment.slice(idx + 1).trim();
    if (!key || !value) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Extract the GA4 client id from the _ga cookie.
 *
 * Format: GA1.<domain-component-count>.<cid-part1>.<cid-part2>, e.g.
 * "GA1.1.1234567890.1698765432" -> "1234567890.1698765432". The component
 * count varies with the domain (1, 2, 3...), so the client id is everything
 * after the first two dot-separated fields rather than a fixed index.
 * Returns null when absent or malformed - never a guess.
 */
export function readGaClientId(cookieHeader) {
  const raw = parseCookies(cookieHeader)["_ga"];
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length < 4 || !parts[0].startsWith("GA")) return null;
  const clientId = parts.slice(2).join(".");
  return /^\d+\.\d+$/.test(clientId) ? clientId : null;
}

/**
 * Extract the current GA4 session id from the _ga_<CONTAINER> cookie, where
 * CONTAINER is the measurement id without its "G-" prefix.
 *
 * Two on-the-wire formats exist and both are handled:
 *   GS1.1.<session_id>.<session_number>....   -> field 2
 *   GS2.1.s<session_id>$o<n>$g<n>$t<n>...     -> the s-segment of field 2
 * Returns null when absent or unrecognised, so the caller mints instead of
 * attaching the event to a wrong session.
 */
export function readGaSessionId(cookieHeader, measurementId) {
  if (!measurementId) return null;
  const container = String(measurementId).replace(/^G-/, "");
  if (!container) return null;
  const raw = parseCookies(cookieHeader)[`_ga_${container}`];
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length < 3) return null;
  const field = parts[2];
  if (raw.startsWith("GS1")) {
    return /^\d+$/.test(field) ? field : null;
  }
  // GS2 packs several $-delimited values into the same field.
  for (const segment of field.split("$")) {
    if (segment.startsWith("s")) {
      const id = segment.slice(1);
      if (/^\d+$/.test(id)) return id;
    }
  }
  return null;
}

/**
 * Resolve the identity to report this conversion under.
 *
 * Consented visitors are reported under their existing GA identity so the
 * event joins the session GA4 already has. Non-consenting visitors get a
 * stable first-party id and a minted session id. `consented` reflects which
 * happened and drives the consent block on the payload.
 */
export function resolveIdentity({
  cookieHeader,
  measurementId,
  fallbackCookieName,
  generateId,
  generateSessionId,
}) {
  if (typeof generateId !== "function") {
    throw new Error("resolveIdentity: generateId is required");
  }
  if (!fallbackCookieName) {
    throw new Error("resolveIdentity: fallbackCookieName is required");
  }
  const mintSession =
    typeof generateSessionId === "function"
      ? generateSessionId
      : () => String(Math.floor(Date.now() / 1000));
  const gaClientId = readGaClientId(cookieHeader);
  if (gaClientId) {
    return {
      clientId: gaClientId,
      sessionId: readGaSessionId(cookieHeader, measurementId) || mintSession(),
      consented: true,
      mintedClientId: false,
    };
  }
  const existing = parseCookies(cookieHeader)[fallbackCookieName];
  const clientId = existing || generateId();
  return {
    clientId,
    // Without GA cookies there is no session to join. A per-request integer id
    // keeps the event attributable to itself rather than silently merging
    // unrelated visitors into one session. MUST be a bare integer - see the
    // generator note in createTrackHandler.
    sessionId: mintSession(),
    consented: false,
    mintedClientId: !existing,
  };
}

/**
 * GA4 event params: keys must match [a-zA-Z][a-zA-Z0-9_]{0,39} and values must
 * be primitives. Anything else is dropped, which keeps accidental PII and
 * oversized payloads out of the request.
 */
export function sanitizeParams(raw) {
  const out = {};
  if (raw == null || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 500);
    // NaN / Infinity / -Infinity are `typeof "number"` but JSON.stringify emits
    // them as `null`, so an unguarded numeric param silently reaches GA4 as a
    // null and the metric it was meant to carry is lost with no error anywhere.
    // Dropping the PARAM rather than rejecting the EVENT is deliberate: a
    // malformed score must not cost the conversion it belongs to.
    else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

/** True when `name` is in the site's declared conversion allowlist. */
export function isAllowedEvent(name, allowedEvents) {
  return Array.isArray(allowedEvents) && allowedEvents.includes(name);
}

/**
 * Supported GA4 Measurement ID shape.
 *
 * THIS IS AN APPLICATION-LEVEL SUPPORTED-FORMAT CONTRACT, not a claim about what
 * Google will forever emit. It is deliberately narrow because the failure it
 * prevents is silent: GA4 answers 204 for an unrecognised measurement id and
 * stores nothing, so a typo is indistinguishable from success at the wire.
 * Refusing an unfamiliar-but-real future format is loud and fixable in one env
 * edit; accepting a typo is silent and permanent. That asymmetry is why this
 * fails closed rather than passing anything through.
 *
 * Derived from every id observed across this portfolio: `G-` followed by 10
 * uppercase alphanumerics. The floor is set at 6 rather than 10 so the contract
 * is not brittle against a shorter real id, while still rejecting `G-` and
 * `G-A`. The ceiling rejects implausible values.
 *
 * NOT repaired, deliberately: a lowercase or `_`-separated value is REJECTED,
 * not up-cased or rewritten. Silently repairing a malformed identifier would
 * reintroduce exactly the "the system quietly picked something" behaviour this
 * whole contract exists to remove.
 */
const GA4_MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{6,20}$/;

/**
 * True when `value` is a GA4 Measurement ID this relay will dispatch to.
 *
 * Single source of truth - the pattern is not duplicated into the resolver or
 * into tests.
 */
export function isSupportedGa4MeasurementId(value) {
  return typeof value === "string" && GA4_MEASUREMENT_ID_PATTERN.test(value);
}

/** Fixed reason category for a malformed measurement id. Never derived from input. */
export const MALFORMED_MEASUREMENT_ID_REASON = "malformed_identifier";

/**
 * Build the ONLY public diagnostic for a malformed measurement id.
 *
 * STRUCTURAL PROTECTION, not a convention: this function takes KEY NAMES and
 * nothing else. There is no parameter for the offending value, its length, a
 * prefix, a normalized form, or a hash - so a caller cannot interpolate one even
 * by accident, and a reviewer can confirm that by reading the signature.
 *
 * WHY: a mutation that leaked `(got not-..., length 12)` into the refusal
 * survived the entire v0.12.1 mutation campaign. Asserting only that the FULL
 * value is absent does not prove a prefix, suffix, or length is absent. Partial
 * disclosure of a configured identifier is still disclosure.
 *
 * Allowed content: the fixed reason, the expected FORM, and which configuration
 * KEYS were rejected. Nothing derived from the supplied value.
 */
export function malformedMeasurementIdDiagnostic(malformedKeys) {
  const keys = Array.isArray(malformedKeys) ? malformedKeys.join(" and ") : "";
  return {
    code: "GA4_CONFIG_MALFORMED",
    reason: MALFORMED_MEASUREMENT_ID_REASON,
    error:
      `Unsupported GA4 measurement id in ${keys}. Expected the form G-XXXXXXXXXX. ` +
      `Refusing to dispatch - GA4 accepts an unrecognised id with 204 and stores nothing, ` +
      `so this would look like success. No event was sent.`,
  };
}

/**
 * Resolve the ONE effective measurement id from the declared env keys.
 *
 * WHY THIS IS NOT first-non-empty-wins any more.
 *
 * Until v0.11.3 this loop took the first populated key and stopped. Every
 * consumer declares TWO keys - the default pair, or the explicit
 * ["GA4_MEASUREMENT_ID", "NEXT_PUBLIC_GA4_ID"] used by siteclinic-web and
 * adaauditreport-web - so a stale GA4_MEASUREMENT_ID silently outranked the
 * correct public id and sent every conversion to a different property. Nothing
 * reported it: the relay returned {ok:true}, GA4 returned 204, and the intended
 * property simply stayed empty. That is the same silent-success signature as
 * F-20260803-01, and it is undetectable from any status code.
 *
 * Ambiguous configuration is now a REFUSAL, not a coin flip. Refusing is loud,
 * attributable, and fixable in one env edit; choosing silently is none of those.
 *
 * Returns one of:
 *   { status: "VALID",     measurementId, sourceKeys, duplicate }
 *   { status: "MISSING",   keys }
 *   { status: "MALFORMED", malformedKeys, keys }
 *   { status: "CONFLICT",  conflictingKeys, keys }
 *
 * CONFLICT and MALFORMED deliberately carry NO values - not the value, not a
 * prefix, suffix, length, hash, or normalized form - so a caller cannot leak a
 * measurement id into an error string by accident. Empty and whitespace-only
 * values are treated as absent; surrounding whitespace is trimmed and nothing
 * else about the identifier is rewritten.
 */
export function resolveMeasurementId(env, keys) {
  const declared = Array.isArray(keys) ? keys : [];
  const populated = [];
  for (const key of declared) {
    const raw = env ? env[key] : undefined;
    if (raw == null) continue;
    const value = typeof raw === "string" ? raw.trim() : String(raw).trim();
    if (value.length === 0) continue;
    populated.push({ key, value });
  }

  if (populated.length === 0) {
    return { status: "MISSING", keys: declared };
  }

  // MALFORMED is checked BEFORE conflict, and a malformed SECONDARY source is
  // not excused by a valid primary. If any configured source holds a value this
  // relay cannot dispatch to, the configuration is wrong and a human must look
  // at it - silently preferring the readable one would hide a real mistake and
  // could mean half the deployment's config points somewhere unusable.
  const malformed = populated.filter((p) => !isSupportedGa4MeasurementId(p.value));
  if (malformed.length > 0) {
    return {
      // Key NAMES only. No value, no substring, no length - a caller must not be
      // able to reconstruct or echo a configured identifier from this object.
      status: "MALFORMED",
      malformedKeys: malformed.map((p) => p.key),
      keys: declared,
    };
  }

  const distinct = [...new Set(populated.map((p) => p.value))];
  if (distinct.length === 1) {
    return {
      status: "VALID",
      measurementId: distinct[0],
      sourceKeys: populated.map((p) => p.key),
      duplicate: populated.length > 1,
    };
  }

  return {
    status: "CONFLICT",
    conflictingKeys: populated.map((p) => p.key),
    keys: declared,
  };
}

/**
 * Build the Measurement Protocol body.
 *
 * session_id and engagement_time_msec are EVENT params - GA4 ignores them at
 * the top level, which is precisely how the previous implementation shipped a
 * payload that returned 204 while attaching to no session.
 */
export function buildMeasurementProtocolPayload({
  name,
  params,
  clientId,
  sessionId,
  engagementTimeMsec = DEFAULT_ENGAGEMENT_TIME_MSEC,
  consented = false,
}) {
  if (!name) throw new Error("buildMeasurementProtocolPayload: name is required");
  if (!clientId) throw new Error("buildMeasurementProtocolPayload: clientId is required");
  if (!sessionId) throw new Error("buildMeasurementProtocolPayload: sessionId is required");

  const payload = {
    client_id: clientId,
    events: [
      {
        name,
        params: {
          ...sanitizeParams(params),
          session_id: String(sessionId),
          engagement_time_msec: engagementTimeMsec,
        },
      },
    ],
  };
  if (!consented) {
    // Count the conversion, but never let it feed advertising personalisation
    // for a visitor who did not opt in.
    payload.consent = {
      ad_user_data: "DENIED",
      ad_personalization: "DENIED",
    };
  }
  return payload;
}

/**
 * Build the POST /api/track handler. Framework-agnostic: takes a Web Request,
 * returns a Web Response, so any Next.js App Router route can
 * `export const POST = createTrackHandler({ allowedEvents: [...] })`.
 *
 * Per §3.1.3 layer 9 (UNKNOWN over false): missing config returns 503 with a
 * named gap, never a silent 200 that would read as a working relay.
 */
export function createTrackHandler(options) {
  const opts = options || {};
  const allowedEvents = opts.allowedEvents;
  if (!Array.isArray(allowedEvents) || allowedEvents.length === 0) {
    throw new Error(
      "createTrackHandler: allowedEvents is required (the site's conversion event names, e.g. ['book_buy_click']).",
    );
  }
  const fallbackCookieName = opts.fallbackCookieName || "bwt_cid";
  const cookieMaxAgeSeconds = opts.cookieMaxAgeSeconds ?? 63072000; // 2 years
  const fetchImpl = opts.fetchImpl || ((...args) => fetch(...args));
  const getEnv = opts.getEnv || (() => process.env);
  // GA4 wants two DIFFERENT shapes, and conflating them silently broke the
  // entire non-consenting population (2026-08-03):
  //   client_id  "<random>.<epoch-seconds>"  - dotted, mirrors the _ga cookie
  //   session_id "<epoch-seconds>"           - a BARE INTEGER
  // One generator was used for both. A consenting visitor was fine, because
  // their session_id was read from _ga_<CONTAINER> and was already an integer.
  // A non-consenting visitor got a dotted session_id, and GA4 returned 204 and
  // discarded the event. That is the whole population this relay exists to
  // serve, and on a site with no gtag fallback it is 100% of conversions.
  const generateClientId =
    opts.generateId ||
    (() => `${Math.floor(Math.random() * 1e10)}.${Math.floor(Date.now() / 1000)}`);
  const generateSessionId =
    opts.generateSessionId || (() => String(Math.floor(Date.now() / 1000)));
  // Consumers predate this module and resolve the measurement id from their own
  // env names (adaauditreport-web uses NEXT_PUBLIC_GA4_ID). Renaming env vars
  // across nine production projects to suit a shared module is the riskier
  // direction, so the module accommodates the consumer. Unknown names are still
  // NOT probed - an undeclared key fails closed with a 503.
  // Off by default: see the delivery note in the handler body.
  const forwardIpAddress = opts.forwardIpAddress === true;
  const forwardUserAgent = opts.forwardUserAgent === true;
  const measurementIdEnvKeys =
    opts.measurementIdEnvKeys && opts.measurementIdEnvKeys.length > 0
      ? opts.measurementIdEnvKeys
      : ["GA4_MEASUREMENT_ID", "NEXT_PUBLIC_GA_MEASUREMENT_ID"];

  return async function handleTrackPost(request) {
    const env = getEnv();
    // TRIM. A deploy platform's env editor happily stores a trailing newline,
    // and every UI renders "G-XXXX\n" identically to "G-XXXX". Untrimmed, that
    // becomes measurement_id=G-XXXX%0A in the query string; GA4 does not
    // recognise the id, answers 204, and stores nothing - indistinguishable at
    // the wire from success. It cost jeffrystein.com every conversion it ever
    // sent, while its CLIENT tag kept working because the site's own layout
    // calls .trim() and stray whitespace inside a gtag('config', ...) string is
    // harmless. Same reasoning applies to the secret: a newline there fails
    // auth just as silently. _audit-vault F-20260803-01.
    const readEnv = (key) => {
      const v = env[key];
      return typeof v === "string" ? v.trim() : v;
    };
    const resolution = resolveMeasurementId(env, measurementIdEnvKeys);
    const apiSecret = readEnv("GA4_API_SECRET");

    // CONFLICT is checked FIRST and separately from MISSING. Collapsing them
    // into one 503 would tell an operator "configure a measurement id" when the
    // real problem is that they configured two, which sends them looking for an
    // absent variable that is in fact present twice.
    if (resolution.status === "CONFLICT") {
      return jsonResponse(
        {
          code: "GA4_CONFIG_CONFLICT",
          error:
            `Ambiguous GA4 configuration: ${resolution.conflictingKeys.join(" and ")} are both set to different measurement ids. ` +
            `Refusing to choose - set exactly one, or make them identical. No event was sent.`,
        },
        503,
      );
    }

    // A malformed id is the defect class this refusal exists for: GA4 answers
    // 204 for an id it does not recognise and stores nothing, so without this
    // check a typo produces an indistinguishable-from-success 200 forever.
    if (resolution.status === "MALFORMED") {
      // Single safe constructor. Do not inline a message here - see the note on
      // malformedMeasurementIdDiagnostic for why the value cannot be a parameter.
      return jsonResponse(malformedMeasurementIdDiagnostic(resolution.malformedKeys), 503);
    }

    if (resolution.status === "MISSING" || !apiSecret) {
      return jsonResponse(
        {
          code: "GA4_CONFIG_MISSING",
          error:
            `A measurement id (one of: ${measurementIdEnvKeys.join(", ")}) and GA4_API_SECRET must be configured.`,
        },
        503,
      );
    }

    const measurementId = resolution.measurementId;

    let raw;
    try {
      raw = await request.json();
    } catch {
      return jsonResponse({ error: "Body is not valid JSON." }, 400);
    }
    if (raw == null || typeof raw !== "object") {
      return jsonResponse({ error: "Body must be a JSON object." }, 400);
    }
    const name = raw.name;
    if (typeof name !== "string" || name.length === 0) {
      return jsonResponse({ error: "Body.name is required (string)." }, 400);
    }
    if (!isAllowedEvent(name, allowedEvents)) {
      return jsonResponse(
        {
          error: `Event "${name}" is not in the allowlist. Allowed: ${allowedEvents.join(", ")}.`,
        },
        400,
      );
    }

    const cookieHeader = request.headers.get("cookie") || "";
    const identity = resolveIdentity({
      cookieHeader,
      measurementId,
      fallbackCookieName,
      generateId: generateClientId,
      generateSessionId,
    });

    const payload = buildMeasurementProtocolPayload({
      name,
      params: raw.params,
      clientId: identity.clientId,
      sessionId: identity.sessionId,
      engagementTimeMsec: opts.engagementTimeMsec,
      consented: identity.consented,
    });

    // Send EXACTLY the payload proven to be accepted and processed by GA4.
    //
    // 2026-08-01: an identical hand-rolled request from a laptop landed in the
    // property within seconds, while the server's request returned the same 204
    // and was silently discarded - every time, for months, across two
    // independently written implementations. The only difference between the
    // two calls was the extra context the server attached: user_ip_address from
    // x-forwarded-for, and the visitor's User-Agent forwarded as a request
    // header. Both were present in the pre-2026-07-31 implementation too, which
    // is why NO conversion event has ever reached ANY property in this
    // portfolio. Removing them is what made delivery work.
    //
    // Both are therefore OFF by default and opt-in per consumer. Do not turn
    // them on without re-proving delivery on that property first: the failure
    // mode is a silent 204, so nothing will tell you it broke.
    //
    // Cost of leaving IP off: GA4 derives geo from the sender, i.e. the
    // serverless region, so server-relayed conversions carry the function's
    // location rather than the visitor's. An attributable conversion with wrong
    // geo beats a correctly-geolocated conversion that does not exist.
    const body = { ...payload };
    if (forwardIpAddress && identity.consented) {
      const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
      if (ip) body.user_ip_address = ip;
    }

    const url = `${MP_ENDPOINT}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
    let upstream;
    try {
      upstream = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Forwarding the visitor's User-Agent is opt-in for the same reason
          // as user_ip_address above - see that comment.
          ...(forwardUserAgent && request.headers.get("user-agent")
            ? { "User-Agent": request.headers.get("user-agent") }
            : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return jsonResponse(
        { error: `GA4 Measurement Protocol unreachable: ${err && err.message ? err.message : "Network error"}` },
        502,
      );
    }
    if (upstream.status !== 204) {
      let text = "";
      try {
        text = await upstream.text();
      } catch {
        /* body already consumed or unreadable; status is the signal */
      }
      return jsonResponse(
        { error: `GA4 Measurement Protocol returned ${upstream.status}: ${text.slice(0, 200)}` },
        502,
      );
    }

    const response = jsonResponse({ ok: true, event: name }, 200);
    if (identity.mintedClientId) {
      response.headers.append(
        "set-cookie",
        `${fallbackCookieName}=${encodeURIComponent(identity.clientId)}; Path=/; Max-Age=${cookieMaxAgeSeconds}; Secure; SameSite=Lax`,
      );
    }
    return response;
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
