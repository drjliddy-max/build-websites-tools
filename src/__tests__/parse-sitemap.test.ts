/*
 * Contract for structured sitemap.xml parsing.
 *
 * Replaces the previous /<loc>([^<]+)<\/loc>/g extraction, which could not see
 * <lastmod> at all and mis-read entity-escaped URLs and namespace-prefixed
 * documents. These tests pin the behaviours regex could not deliver.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSitemapXml } from "../parse-sitemap";

const WRAP = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${inner}</urlset>`;

test("parses full structured records, not just locations", () => {
  const result = parseSitemapXml(
    WRAP(`
    <url>
      <loc>https://example.com/</loc>
      <lastmod>2026-07-09T00:00:00.000Z</lastmod>
      <changefreq>weekly</changefreq>
      <priority>1</priority>
    </url>`),
  );

  assert.equal(result.valid, true);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0], {
    url: "https://example.com/",
    lastModified: "2026-07-09T00:00:00.000Z",
    changeFrequency: "weekly",
    priority: "1",
  });
});

test("reports absent lastmod as null rather than dropping the entry", () => {
  const result = parseSitemapXml(WRAP(`<url><loc>https://example.com/a</loc></url>`));
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].lastModified, null);
  assert.equal(result.entries[0].changeFrequency, null);
});

test("treats an empty lastmod element as absent", () => {
  const result = parseSitemapXml(
    WRAP(`<url><loc>https://example.com/a</loc><lastmod>   </lastmod></url>`),
  );
  assert.equal(result.entries[0].lastModified, null);
});

test("decodes entity-escaped URLs (the regex returned them raw)", () => {
  const result = parseSitemapXml(
    WRAP(`<url><loc>https://example.com/s?a=1&amp;b=2</loc></url>`),
  );
  assert.equal(result.entries[0].url, "https://example.com/s?a=1&b=2");
});

test("handles a namespace-prefixed document", () => {
  const result = parseSitemapXml(
    `<?xml version="1.0" encoding="UTF-8"?>
     <sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
       <sm:url>
         <sm:loc>https://example.com/prefixed</sm:loc>
         <sm:lastmod>2026-06-01</sm:lastmod>
       </sm:url>
     </sm:urlset>`,
  );
  assert.equal(result.valid, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].url, "https://example.com/prefixed");
  assert.equal(result.entries[0].lastModified, "2026-06-01");
});

test("handles extension namespaces (image/news) without confusing <loc>", () => {
  const result = parseSitemapXml(
    `<?xml version="1.0" encoding="UTF-8"?>
     <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
             xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
       <url>
         <loc>https://example.com/gallery</loc>
         <lastmod>2026-06-01</lastmod>
         <image:image><image:loc>https://cdn.example.com/a.jpg</image:loc></image:image>
       </url>
     </urlset>`,
  );
  assert.equal(result.entries.length, 1);
  assert.equal(
    result.entries[0].url,
    "https://example.com/gallery",
    "the page <loc> must win over the nested image <loc>",
  );
});

test("a nested extension <loc> cannot hijack the page URL, even when it comes first", () => {
  // Document-order-dependent parsing would return the CDN asset here.
  const result = parseSitemapXml(
    `<?xml version="1.0" encoding="UTF-8"?>
     <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
             xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
       <url>
         <image:image><image:loc>https://cdn.example.com/a.jpg</image:loc></image:image>
         <loc>https://example.com/gallery</loc>
         <lastmod>2026-06-01</lastmod>
       </url>
     </urlset>`,
  );
  assert.equal(result.entries[0].url, "https://example.com/gallery");
  assert.equal(result.entries[0].lastModified, "2026-06-01");
});

test("reports malformed XML as an error instead of throwing", () => {
  const result = parseSitemapXml(`<urlset><url><loc>https://example.com/</loc></urlset>`);
  assert.equal(result.valid, false);
  assert.ok(result.error && result.error.length > 0);
  assert.equal(result.entries.length, 0);
});

test("reports an empty body as an error", () => {
  const result = parseSitemapXml("");
  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /empty/);
});

test("rejects a non-sitemap root element by name", () => {
  const result = parseSitemapXml(`<?xml version="1.0"?><html><body/></html>`);
  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /found <html>/);
});

test("recognises a sitemap index and surfaces its children", () => {
  const result = parseSitemapXml(
    `<?xml version="1.0" encoding="UTF-8"?>
     <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
       <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
       <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
     </sitemapindex>`,
  );
  assert.equal(result.valid, true);
  assert.equal(result.isIndex, true);
  assert.deepEqual(result.sitemapLocations, [
    "https://example.com/sitemap-1.xml",
    "https://example.com/sitemap-2.xml",
  ]);
});

test("preserves document order and every entry (route parity depends on it)", () => {
  const result = parseSitemapXml(
    WRAP(
      ["/", "/about", "/pricing", "/contact"]
        .map((p) => `<url><loc>https://example.com${p}</loc><lastmod>2026-06-01</lastmod></url>`)
        .join(""),
    ),
  );
  assert.deepEqual(
    result.entries.map((e) => e.url),
    [
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/pricing",
      "https://example.com/contact",
    ],
  );
});

test("keeps duplicate locations so the validator can flag them", () => {
  const result = parseSitemapXml(
    WRAP(
      `<url><loc>https://example.com/a</loc></url><url><loc>https://example.com/a</loc></url>`,
    ),
  );
  assert.equal(result.entries.length, 2, "parser must not silently de-duplicate");
});
