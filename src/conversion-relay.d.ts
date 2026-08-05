// Type surface for conversion-relay.js. See that file for the contract and
// the audit trail (_audit-vault F-20260731-02/-03/-05).

export declare const DEFAULT_ENGAGEMENT_TIME_MSEC: number;

export declare function parseCookies(cookieHeader: string | null | undefined): Record<string, string>;

export declare function readGaClientId(cookieHeader: string | null | undefined): string | null;

export declare function readGaSessionId(
  cookieHeader: string | null | undefined,
  measurementId: string | null | undefined,
): string | null;

export interface ResolvedIdentity {
  clientId: string;
  sessionId: string;
  /** True when the visitor already had a GA identity, i.e. had consented. */
  consented: boolean;
  /** True when a first-party id was minted this request and needs persisting. */
  mintedClientId: boolean;
}

export declare function resolveIdentity(options: {
  cookieHeader: string | null | undefined;
  measurementId: string | null | undefined;
  fallbackCookieName: string;
  generateId: () => string;
  generateSessionId?: () => string;
}): ResolvedIdentity;

export declare function sanitizeParams(raw: unknown): Record<string, string | number | boolean>;

/** Outcome of resolving the one effective measurement id from declared env keys. */
export type MeasurementIdResolution =
  | {
      status: "VALID";
      measurementId: string;
      /** Every declared key that was populated with this value. */
      sourceKeys: string[];
      /** True when more than one declared key carried the same value. */
      duplicate: boolean;
    }
  | { status: "MISSING"; keys: string[] }
  /** One or more configured sources hold a value this relay cannot dispatch to.
   *  Carries key NAMES only - never values, substrings, or lengths. */
  | { status: "MALFORMED"; malformedKeys: string[]; keys: string[] }
  /** Carries key NAMES only - never values - so an error cannot leak an id. */
  | { status: "CONFLICT"; conflictingKeys: string[]; keys: string[] };

/**
 * True when `value` matches the supported GA4 Measurement ID shape
 * (`G-` + 6..20 uppercase alphanumerics).
 *
 * An application-level supported-format contract, not a claim about Google's
 * present or future identifier shapes. Malformed values are REFUSED, never
 * repaired: GA4 answers 204 for an id it does not recognise and stores nothing,
 * so accepting a typo is silent and permanent while refusing is loud and fixed
 * by one env edit.
 */
export declare function isSupportedGa4MeasurementId(value: unknown): boolean;

/**
 * Resolve exactly one effective measurement id, or refuse.
 *
 * Empty and whitespace-only values are absent. Surrounding whitespace is
 * trimmed; the identifier is not otherwise rewritten. Two declared keys holding
 * DIFFERENT values is a CONFLICT, not a precedence decision.
 */
export declare function resolveMeasurementId(
  env: Record<string, string | undefined>,
  keys: string[],
): MeasurementIdResolution;

export declare function isAllowedEvent(name: string, allowedEvents: readonly string[]): boolean;

export interface MeasurementProtocolPayload {
  client_id: string;
  events: { name: string; params: Record<string, unknown> }[];
  consent?: { ad_user_data: string; ad_personalization: string };
}

export declare function buildMeasurementProtocolPayload(options: {
  name: string;
  params?: unknown;
  clientId: string;
  sessionId: string;
  engagementTimeMsec?: number;
  consented?: boolean;
}): MeasurementProtocolPayload;

export declare function createTrackHandler(options: {
  /** The site's conversion event names. Required, non-empty. */
  allowedEvents: readonly string[];
  /** First-party id cookie for non-consenting visitors. Default "bwt_cid". */
  fallbackCookieName?: string;
  /**
   * Env var names to read the GA4 measurement id from, in order.
   * Default ["GA4_MEASUREMENT_ID", "NEXT_PUBLIC_GA_MEASUREMENT_ID"].
   * Declare explicitly when a site predates this module and uses another
   * name (e.g. adaauditreport-web's NEXT_PUBLIC_GA4_ID). Undeclared names
   * are never probed - the handler fails closed with 503.
   */
  measurementIdEnvKeys?: readonly string[];
  /**
   * Attach user_ip_address (from x-forwarded-for) for consenting visitors.
   * Default FALSE. Enabling it caused GA4 to silently discard every event
   * (204 returned, nothing processed) - see the note in conversion-relay.js.
   * Do not enable without re-proving delivery on that property.
   */
  forwardIpAddress?: boolean;
  /** Forward the visitor's User-Agent header. Default FALSE, same reason. */
  forwardUserAgent?: boolean;
  cookieMaxAgeSeconds?: number;
  engagementTimeMsec?: number;
  fetchImpl?: typeof fetch;
  getEnv?: () => Record<string, string | undefined>;
  /** Mints a client_id in the dotted "<random>.<epoch>" GA form. */
  generateId?: () => string;
  /**
   * Mints a session_id. MUST return a BARE INTEGER string - GA4 discards an
   * event whose session_id carries the dotted client_id shape, returning 204
   * and storing nothing. Default: epoch seconds.
   */
  generateSessionId?: () => string;
}): (request: Request) => Promise<Response>;
