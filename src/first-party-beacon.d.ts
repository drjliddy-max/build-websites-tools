// Type surface for ./first-party-beacon (see first-party-beacon.js for
// behavior and the shared/consumer responsibility split).

/** Bot/tool user-agent denylist shared by the client predicate and the /api/ln handler. */
export declare const BLOCKED_UA_PATTERN: RegExp;

export interface ShouldSendPageViewInput {
  /** navigator.userAgent (empty/undefined means: do not send). */
  userAgent: string | null | undefined;
  /** window.location.hostname; vercel.app preview hosts are skipped. */
  hostname: string;
}

/** Client-side predicate: should this page load fire the beacon? */
export declare function shouldSendPageView(input: ShouldSendPageViewInput): boolean;

export interface PageViewPayload {
  domain: string;
  path: string;
  referrer: string | null;
}

/** Build the POST /api/ln body from browser state. */
export declare function buildPageViewPayload(input: {
  hostname: string;
  pathname: string;
  referrer?: string | null;
}): PageViewPayload;

export interface CreateLnHandlerOptions {
  /** The site's own production hostnames, e.g. ["example.com", "www.example.com"]. Required, non-empty. */
  ownHosts: Iterable<string>;
  /** Test seam: env source; defaults to reading process.env per request. */
  getEnv?: () => Record<string, string | undefined>;
  /** Test seam: fetch implementation; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the POST /api/ln route handler (Web Request in, Web Response out).
 * Usage in a Next.js App Router route:
 *   export const dynamic = "force-dynamic";
 *   export const POST = createLnHandler({ ownHosts: ["example.com", "www.example.com"] });
 */
export declare function createLnHandler(
  options: CreateLnHandlerOptions,
): (request: Request) => Promise<Response>;
