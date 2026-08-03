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
}): ResolvedIdentity;

export declare function sanitizeParams(raw: unknown): Record<string, string | number | boolean>;

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
  generateId?: () => string;
}): (request: Request) => Promise<Response>;
