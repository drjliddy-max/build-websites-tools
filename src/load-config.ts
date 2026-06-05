/*
 * Loads and validates gate.config.json from the CONSUMING site's cwd.
 *
 * Strict: fails loudly with a clear message on missing file, invalid JSON,
 * missing fields, or malformed values. No silent defaults — a missing or
 * malformed config is a build failure, not a "fall back to /." Sites that
 * skip the config don't get gates.
 */
import path from "node:path";
import fs from "node:fs";

export interface GateConfig {
  routes: string[];
  baseUrl: string;
  launchCommand?: string;
  startupTimeoutMs?: number;
  allowedOffSitemapRoutes?: string[];
  productionSeo?: {
    allowClientOnlyRoutes?: string[];
    minServerRenderedTextChars?: number;
    requireServerRenderedHtml?: boolean;
    requiredHealthPaths?: string[];
    requiredApiDependencyPaths?: string[];
    requireHtmlCacheControl?: boolean;
    requireStaticAssetCacheControl?: boolean;
    requireSecurityHeaders?: boolean;
  };
  expectedRedirects?: Array<{
    source: string;
    destination: string;
    status: number;
  }>;
}

const USAGE_HINT = `gate.config.json must exist at the consuming site's repo root with this shape:
  {
    "routes": ["/", "/about", "/pricing"],
    "baseUrl": "http://127.0.0.1:3000",
    "launchCommand": "npm run dev -- --hostname 127.0.0.1 --port 3000"
  }

  routes: non-empty array of paths, each starting with "/"
  baseUrl: http(s) URL the gate connects to (can be overridden by GATE_BASE_URL env var)
  launchCommand: optional shell command used when baseUrl is local and no server is already running
  startupTimeoutMs: optional positive integer wait time for launchCommand readiness
  allowedOffSitemapRoutes: optional array of internal same-origin paths intentionally linked but excluded from sitemap
  productionSeo: optional production SEO architecture gates for server-rendered HTML, health, dependency, cache, and security checks
  expectedRedirects: optional array of redirect contracts to verify during the SEO gate`;

export function loadGateConfig(): GateConfig {
  const configPath = path.join(process.cwd(), "gate.config.json");

  if (!fs.existsSync(configPath)) {
    console.error(`✗ gate.config.json not found at ${configPath}`);
    console.error(USAGE_HINT);
    process.exit(1);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    console.error(`✗ failed to read ${configPath}: ${(err as Error).message}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`✗ ${configPath} is not valid JSON: ${(err as Error).message}`);
    console.error(USAGE_HINT);
    process.exit(1);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error(`✗ ${configPath} must be a JSON object`);
    console.error(USAGE_HINT);
    process.exit(1);
  }

  const obj = parsed as Record<string, unknown>;

  // routes validation
  if (!("routes" in obj)) {
    console.error(`✗ ${configPath}: "routes" field is required`);
    console.error(USAGE_HINT);
    process.exit(1);
  }
  if (!Array.isArray(obj.routes) || obj.routes.length === 0) {
    console.error(
      `✗ ${configPath}: "routes" must be a non-empty array — got ${JSON.stringify(obj.routes)}`,
    );
    process.exit(1);
  }
  const badRoutes = obj.routes.filter(
    (r) => typeof r !== "string" || !(r).startsWith("/"),
  );
  if (badRoutes.length > 0) {
    console.error(
      `✗ ${configPath}: every route must be a string starting with "/" — bad entries: ${JSON.stringify(badRoutes)}`,
    );
    process.exit(1);
  }

  /*
   * Required-pages check — added 2026-06-05 after jeffrystein-web shipped
   * to production without /privacy, /terms, or /accessibility. The gate
   * was scanning whatever was listed in routes, but never verifying that
   * the doctrine-required pages were among them. Result: false-green
   * builds on legally-incomplete sites.
   *
   * Per build-websites-template/03-build-standard.md, these five pages
   * are REQUIRED on every owned marketing site:
   *
   *   /                — homepage
   *   /privacy         — privacy policy
   *   /terms           — terms of service
   *   /accessibility   — accessibility statement (WCAG + ADA disclosure)
   *   /contact         — direct-inquiry surface
   *
   * No opt-out flag. Opt-outs are how sites end up legally incomplete.
   * If a site genuinely doesn't need /contact (e.g., book-only with no
   * inquiry path), that's a product decision the operator should make
   * via a documented exception in the site's CLAUDE.md, not a quiet
   * gate-config omission. Fix the spec, not the enforcement.
   */
  const REQUIRED_PAGES = [
    "/",
    "/privacy",
    "/terms",
    "/accessibility",
    "/contact",
  ] as const;
  const routesAsStrings = obj.routes as string[];
  const missingRequired = REQUIRED_PAGES.filter(
    (p) => !routesAsStrings.includes(p),
  );
  if (missingRequired.length > 0) {
    console.error(
      `✗ ${configPath}: missing required page(s) from routes — ${JSON.stringify(missingRequired)}`,
    );
    console.error(
      `  Per build-websites-template/03-build-standard.md, every owned marketing site must`,
    );
    console.error(
      `  expose: /, /privacy, /terms, /accessibility, /contact. Add the missing entries to`,
    );
    console.error(
      `  the routes array AND create the corresponding page files (the route scan that`,
    );
    console.error(
      `  follows will catch routes-without-pages with a 404).`,
    );
    process.exit(1);
  }

  // baseUrl validation
  if (!("baseUrl" in obj)) {
    console.error(`✗ ${configPath}: "baseUrl" field is required`);
    console.error(USAGE_HINT);
    process.exit(1);
  }
  if (
    typeof obj.baseUrl !== "string" ||
    !/^https?:\/\/[^\s]+$/.test(obj.baseUrl)
  ) {
    console.error(
      `✗ ${configPath}: "baseUrl" must be an http(s) URL — got ${JSON.stringify(obj.baseUrl)}`,
    );
    process.exit(1);
  }

  // env var override (useful for CI/staging/production checks)
  const envOverride = process.env.GATE_BASE_URL;
  if (envOverride && !/^https?:\/\/[^\s]+$/.test(envOverride)) {
    console.error(
      `✗ GATE_BASE_URL env var must be an http(s) URL — got ${JSON.stringify(envOverride)}`,
    );
    process.exit(1);
  }

  if (
    "launchCommand" in obj &&
    obj.launchCommand !== undefined &&
    typeof obj.launchCommand !== "string"
  ) {
    console.error(
      `✗ ${configPath}: "launchCommand" must be a string when provided — got ${JSON.stringify(obj.launchCommand)}`,
    );
    process.exit(1);
  }

  if (
    "startupTimeoutMs" in obj &&
    obj.startupTimeoutMs !== undefined &&
    (!Number.isInteger(obj.startupTimeoutMs) || Number(obj.startupTimeoutMs) <= 0)
  ) {
    console.error(
      `✗ ${configPath}: "startupTimeoutMs" must be a positive integer when provided — got ${JSON.stringify(obj.startupTimeoutMs)}`,
    );
    process.exit(1);
  }

  if (
    "allowedOffSitemapRoutes" in obj &&
    obj.allowedOffSitemapRoutes !== undefined
  ) {
    if (!Array.isArray(obj.allowedOffSitemapRoutes)) {
      console.error(
        `✗ ${configPath}: "allowedOffSitemapRoutes" must be an array when provided — got ${JSON.stringify(obj.allowedOffSitemapRoutes)}`,
      );
      process.exit(1);
    }

    const badAllowedOffSitemapRoutes = obj.allowedOffSitemapRoutes.filter(
      (route) => typeof route !== "string" || !(route).startsWith("/"),
    );
    if (badAllowedOffSitemapRoutes.length > 0) {
      console.error(
        `✗ ${configPath}: every allowedOffSitemapRoutes entry must be a string starting with "/" — bad entries: ${JSON.stringify(badAllowedOffSitemapRoutes)}`,
      );
      process.exit(1);
    }
  }

  if ("expectedRedirects" in obj && obj.expectedRedirects !== undefined) {
    if (!Array.isArray(obj.expectedRedirects)) {
      console.error(
        `✗ ${configPath}: "expectedRedirects" must be an array when provided — got ${JSON.stringify(obj.expectedRedirects)}`,
      );
      process.exit(1);
    }

    for (const entry of obj.expectedRedirects) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        console.error(
          `✗ ${configPath}: each expectedRedirects entry must be an object — got ${JSON.stringify(entry)}`,
        );
        process.exit(1);
      }

      const redirect = entry as Record<string, unknown>;
      if (typeof redirect.source !== "string" || !redirect.source.startsWith("/")) {
        console.error(
          `✗ ${configPath}: expectedRedirects.source must start with "/" — got ${JSON.stringify(redirect.source)}`,
        );
        process.exit(1);
      }
      if (
        typeof redirect.destination !== "string" ||
        !redirect.destination.startsWith("/")
      ) {
        console.error(
          `✗ ${configPath}: expectedRedirects.destination must start with "/" — got ${JSON.stringify(redirect.destination)}`,
        );
        process.exit(1);
      }
      if (
        !Number.isInteger(redirect.status) ||
        Number(redirect.status) < 300 ||
        Number(redirect.status) > 399
      ) {
        console.error(
          `✗ ${configPath}: expectedRedirects.status must be a 3xx integer — got ${JSON.stringify(redirect.status)}`,
        );
        process.exit(1);
      }
    }
  }

  if ("productionSeo" in obj && obj.productionSeo !== undefined) {
    if (
      typeof obj.productionSeo !== "object" ||
      obj.productionSeo === null ||
      Array.isArray(obj.productionSeo)
    ) {
      console.error(
        `✗ ${configPath}: "productionSeo" must be an object when provided — got ${JSON.stringify(obj.productionSeo)}`,
      );
      process.exit(1);
    }

    const productionSeo = obj.productionSeo as Record<string, unknown>;

    for (const key of [
      "allowClientOnlyRoutes",
      "requiredHealthPaths",
      "requiredApiDependencyPaths",
    ]) {
      const value = productionSeo[key];
      if (value === undefined) continue;
      if (!Array.isArray(value)) {
        console.error(
          `✗ ${configPath}: "productionSeo.${key}" must be an array when provided — got ${JSON.stringify(value)}`,
        );
        process.exit(1);
      }
      const badPaths = value.filter(
        (route) => typeof route !== "string" || !(route).startsWith("/"),
      );
      if (badPaths.length > 0) {
        console.error(
          `✗ ${configPath}: every productionSeo.${key} entry must be a string starting with "/" — bad entries: ${JSON.stringify(badPaths)}`,
        );
        process.exit(1);
      }
    }

    if (
      productionSeo.minServerRenderedTextChars !== undefined &&
      (
        !Number.isInteger(productionSeo.minServerRenderedTextChars) ||
        Number(productionSeo.minServerRenderedTextChars) < 0
      )
    ) {
      console.error(
        `✗ ${configPath}: "productionSeo.minServerRenderedTextChars" must be a non-negative integer when provided — got ${JSON.stringify(productionSeo.minServerRenderedTextChars)}`,
      );
      process.exit(1);
    }

    for (const key of [
      "requireHtmlCacheControl",
      "requireServerRenderedHtml",
      "requireStaticAssetCacheControl",
      "requireSecurityHeaders",
    ]) {
      const value = productionSeo[key];
      if (value !== undefined && typeof value !== "boolean") {
        console.error(
          `✗ ${configPath}: "productionSeo.${key}" must be a boolean when provided — got ${JSON.stringify(value)}`,
        );
        process.exit(1);
      }
    }
  }

  return {
    routes: obj.routes as string[],
    baseUrl: envOverride || (obj.baseUrl as string),
    launchCommand:
      typeof obj.launchCommand === "string" ? obj.launchCommand : undefined,
    startupTimeoutMs:
      typeof obj.startupTimeoutMs === "number" ? obj.startupTimeoutMs : undefined,
    allowedOffSitemapRoutes: Array.isArray(obj.allowedOffSitemapRoutes)
      ? (obj.allowedOffSitemapRoutes as string[])
      : undefined,
    productionSeo:
      typeof obj.productionSeo === "object" &&
      obj.productionSeo !== null &&
      !Array.isArray(obj.productionSeo)
        ? (obj.productionSeo as GateConfig["productionSeo"])
        : undefined,
    expectedRedirects: Array.isArray(obj.expectedRedirects)
      ? (obj.expectedRedirects as GateConfig["expectedRedirects"])
      : undefined,
  };
}
