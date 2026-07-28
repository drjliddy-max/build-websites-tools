/*
 * Structured sitemap.xml parsing for gate:seo.
 *
 * WHY this replaced regex extraction: the gate previously pulled locations
 * with /<loc>([^<]+)<\/loc>/g and ignored everything else in the document. That
 * was enough for route parity and nothing else - it could not see <lastmod>,
 * so it could not enforce the portfolio lastmod standard, and it mis-read any
 * document using entity-escaped URLs (&amp; in a query string) or a namespace
 * prefix (<sm:loc>).
 *
 * jsdom is already a dependency and parses XML properly, so entities, CDATA,
 * namespaces, and whitespace are handled by a real parser rather than by
 * pattern-matching on angle brackets.
 *
 * Lives in its own module rather than inside gate-seo.ts because that file
 * invokes main() at import time; a test importing it would run the gate.
 */
import { JSDOM } from "jsdom";

export interface ParsedSitemapEntry {
  /** Raw <loc> text, entity-decoded. */
  url: string;
  /** Raw <lastmod> text, or null when the element is absent or empty. */
  lastModified: string | null;
  changeFrequency: string | null;
  priority: string | null;
}

export interface ParsedSitemap {
  /** True when the document parsed as XML and carried a <urlset> root. */
  valid: boolean;
  /** Human-readable reason when `valid` is false. */
  error: string | null;
  entries: ParsedSitemapEntry[];
  /** True when the document is a <sitemapindex> rather than a <urlset>. */
  isIndex: boolean;
  /** Child sitemap locations, when the document is a sitemap index. */
  sitemapLocations: string[];
}

function textOf(parent: Element, localName: string): string | null {
  // DIRECT children only, matched on local name.
  //
  // Local-name matching so both `<loc>` (default namespace) and `<sm:loc>`
  // (prefixed) resolve; getElementsByTagName matches the qualified name and
  // would miss the prefixed form.
  //
  // Direct-children-only because sitemap extensions nest their own <loc>:
  // <url><image:image><image:loc>…</image:loc></image:image></url>. A
  // descendant search would return whichever came first in document order,
  // so a page whose image block preceded its <loc> would report the CDN asset
  // URL as the page URL.
  for (const child of Array.from(parent.children)) {
    if (child.localName !== localName) continue;
    const text = (child.textContent ?? "").trim();
    return text.length === 0 ? null : text;
  }
  return null;
}

/**
 * Parse a sitemap document into structured records.
 *
 * Never throws: a malformed document returns { valid: false, error } so the
 * gate can report it as a check failure rather than crashing the build with a
 * stack trace.
 */
export function parseSitemapXml(body: string): ParsedSitemap {
  const empty: ParsedSitemap = {
    valid: false,
    error: null,
    entries: [],
    isIndex: false,
    sitemapLocations: [],
  };

  if (typeof body !== "string" || body.trim().length === 0) {
    return { ...empty, error: "sitemap body is empty" };
  }

  let dom: JSDOM;
  try {
    dom = new JSDOM(body, { contentType: "application/xml" });
  } catch (err) {
    return { ...empty, error: `XML parse failed: ${(err as Error).message}` };
  }

  try {
    const { document } = dom.window;

    // jsdom surfaces XML syntax errors as a <parsererror> element rather than
    // by throwing, so the happy path must check for it explicitly.
    const parserError = document.getElementsByTagName("parsererror")[0];
    if (parserError) {
      const detail = (parserError.textContent ?? "").replaceAll(/\s+/g, " ").trim();
      return { ...empty, error: `malformed XML: ${detail.slice(0, 200)}` };
    }

    const root = document.documentElement;
    const rootName = root?.localName ?? "(none)";

    if (rootName === "sitemapindex") {
      const locations = Array.from(root.getElementsByTagNameNS("*", "sitemap"))
        .map((node) => textOf(node as Element, "loc"))
        .filter((loc): loc is string => typeof loc === "string");
      return {
        valid: true,
        error: null,
        entries: [],
        isIndex: true,
        sitemapLocations: locations,
      };
    }

    if (rootName !== "urlset") {
      return {
        ...empty,
        error: `expected a <urlset> or <sitemapindex> root element, found <${rootName}>`,
      };
    }

    const entries = Array.from(root.getElementsByTagNameNS("*", "url"))
      .map((node): ParsedSitemapEntry | null => {
        const element = node as Element;
        const url = textOf(element, "loc");
        if (url === null) return null;
        return {
          url,
          lastModified: textOf(element, "lastmod"),
          changeFrequency: textOf(element, "changefreq"),
          priority: textOf(element, "priority"),
        };
      })
      .filter((entry): entry is ParsedSitemapEntry => entry !== null);

    return {
      valid: true,
      error: null,
      entries,
      isIndex: false,
      sitemapLocations: [],
    };
  } finally {
    dom.window.close();
  }
}
