/*
 * Test fixture: a minimal site that the REAL gate-seo / gate-ada binaries can
 * scan, standing in for `next dev` in the site-monitor#273 regression tests
 * (gate-cleanup-on-exit.test.ts). Launched as the grandchild of
 * gate-site-wrapper.mjs, the way next-server is the grandchild of `npm run dev`.
 *
 * GATE_SITE_MODE selects the defect it serves:
 *   pass             every route passes gate-seo and gate-ada
 *   seo-fail         /contact returns 404, so gate-seo reaches its FAIL branch
 *   seo-throw        /sitemap.xml resets the connection, so gate-seo's main() rejects
 *   ada-blocking     / carries an <img> with no alt (a blocking axe violation)
 *   ada-unreachable  /contact resets the connection (gate-ada's load-failure branch)
 *
 * GATE_SITE_PID_FILE      receives this process's pid, so the test can prove it died.
 * GATE_SITE_TERM_MARKER   is written ONLY when this process receives SIGTERM. The
 *   gate's graceful stopServer() sends SIGTERM; the last-resort exit hook in
 *   ensureBaseUrlReady sends SIGKILL, which cannot be observed. So the marker
 *   proves the gate's own finally ran, not merely that something killed us.
 */
import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.PORT);
const mode = process.env.GATE_SITE_MODE ?? "pass";
const ORIGIN = "https://example.test";
const ROUTES = ["/", "/privacy", "/terms", "/accessibility", "/contact"];

if (process.env.GATE_SITE_PID_FILE) {
  fs.writeFileSync(process.env.GATE_SITE_PID_FILE, String(process.pid));
}

process.on("SIGTERM", () => {
  if (process.env.GATE_SITE_TERM_MARKER) {
    fs.writeFileSync(process.env.GATE_SITE_TERM_MARKER, "SIGTERM");
  }
  process.exit(0);
});

function page(route) {
  const name = route === "/" ? "Home" : route.slice(1);
  const brokenImage = mode === "ada-blocking" && route === "/" ? '<img src="/images/x.png">' : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fixture site ${name} page</title>
<meta name="description" content="A fixture page used to test that build gates stop the server they launched.">
<link rel="canonical" href="${ORIGIN}${route}">
<meta property="og:title" content="Fixture ${name}">
<meta property="og:description" content="Fixture page">
<meta property="og:type" content="website">
<meta property="og:url" content="${ORIGIN}${route}">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Fixture"}</script>
</head>
<body>
<main>
<h1>Fixture ${name}</h1>
<p>Fixture content for the gate cleanup regression test.</p>
${brokenImage}
</main>
</body>
</html>`;
}

function sitemap() {
  const urls = ROUTES.map(
    (route, i) =>
      `<url><loc>${ORIGIN}${route}</loc><lastmod>2026-01-0${i + 1}</lastmod></url>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

const server = http.createServer((req, res) => {
  const route = new URL(req.url ?? "/", "http://fixture").pathname;

  if (
    (mode === "seo-throw" && route === "/sitemap.xml") ||
    (mode === "ada-unreachable" && route === "/contact")
  ) {
    req.socket.destroy();
    return;
  }
  if (route === "/sitemap.xml") {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(sitemap());
    return;
  }
  if (route === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`);
    return;
  }
  if (ROUTES.includes(route) && !(mode === "seo-fail" && route === "/contact")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(route));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});
server.listen(port, "127.0.0.1");
