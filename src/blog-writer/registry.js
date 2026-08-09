/**
 * Canonical site registration.
 *
 * A site participates in the blog pipeline by REGISTERING, not by owning an
 * implementation. This module defines what a registration may contain and
 * validates it. Everything here is data: no callbacks, no executable policy, no
 * orchestration. If a field would need code to express, it belongs in the
 * pipeline or in a named adapter, not in a site's config.
 *
 * The eighth-site test is the design constraint: enrolling a new site must be
 * an entry in this shape plus a keyword source. Nothing else.
 */

/** Registration fields that must be present and non-empty. */
const REQUIRED = [
  "siteId",
  "domain",
  "repository",
  "laneKey",
  "blogPath",
  "keywordSource",
  "contentContext",
  "imagePolicy",
  "publication",
  "monitorKey",
];

const ADAPTERS = new Set(["github-repo-commit"]);
const IMAGE_PROVIDERS = new Set(["pexels", "repo-hosted"]);

/**
 * Assets that must never be accepted as an article photo. `/og-image.jpg` is
 * the branded social card, shipping it as the in-article image was a real
 * defect caught in the qirofit lane, so the protection is estate-wide rather
 * than lane-local.
 */
export const DISALLOWED_IMAGE_PATHS = new Set(["/og-image.jpg", "/og-image.png"]);

export class RegistrationError extends Error {
  constructor(siteId, message) {
    super(`[${siteId ?? "unknown-site"}] ${message}`);
    this.name = "RegistrationError";
    this.siteId = siteId;
  }
}

function requireString(site, field, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RegistrationError(site.siteId, `${field} must be a non-empty string`);
  }
}

/**
 * Validate one registration. Throws on the first violation rather than
 * collecting: a malformed registration must not reach the pipeline at all, and
 * a partial list invites treating some violations as advisory.
 */
export function validateRegistration(site) {
  if (!site || typeof site !== "object") {
    throw new RegistrationError(undefined, "registration must be an object");
  }
  for (const field of REQUIRED) {
    if (site[field] === undefined || site[field] === null) {
      throw new RegistrationError(site.siteId, `missing required field: ${field}`);
    }
  }
  requireString(site, "siteId", site.siteId);
  requireString(site, "domain", site.domain);
  requireString(site, "laneKey", site.laneKey);
  requireString(site, "monitorKey", site.monitorKey);

  if (!/^[a-z0-9-]+$/.test(site.siteId)) {
    throw new RegistrationError(site.siteId, "siteId must be lowercase kebab-case");
  }
  if (site.domain.includes("/") || site.domain.startsWith("http")) {
    throw new RegistrationError(site.siteId, "domain must be a bare hostname");
  }
  if (!site.blogPath.startsWith("/")) {
    throw new RegistrationError(site.siteId, "blogPath must start with /");
  }

  requireString(site, "repository.owner", site.repository?.owner);
  requireString(site, "repository.name", site.repository?.name);
  requireString(site, "keywordSource.primary", site.keywordSource?.primary);

  const ctx = site.contentContext;
  requireString(site, "contentContext.audience", ctx?.audience);
  requireString(site, "contentContext.voice", ctx?.voice);
  if (!Array.isArray(ctx.prohibitedTerms)) {
    throw new RegistrationError(site.siteId, "contentContext.prohibitedTerms must be an array");
  }
  for (const term of ctx.prohibitedTerms) {
    if (typeof term !== "string" || term.trim() === "") {
      throw new RegistrationError(site.siteId, "prohibitedTerms entries must be non-empty strings");
    }
  }

  const image = site.imagePolicy;
  if (typeof image.required !== "boolean") {
    throw new RegistrationError(site.siteId, "imagePolicy.required must be a boolean");
  }
  if (!IMAGE_PROVIDERS.has(image.provider)) {
    throw new RegistrationError(
      site.siteId,
      `imagePolicy.provider must be one of ${[...IMAGE_PROVIDERS].join(", ")}`,
    );
  }
  // A site may opt out of Pexels, but only EXPLICITLY. Silent divergence is the
  // failure mode this whole programme exists to remove.
  if (image.provider === "repo-hosted" && typeof image.optOutReason !== "string") {
    throw new RegistrationError(
      site.siteId,
      "imagePolicy.provider 'repo-hosted' requires an explicit optOutReason",
    );
  }

  if (!ADAPTERS.has(site.publication.adapter)) {
    throw new RegistrationError(
      site.siteId,
      `publication.adapter must be one of ${[...ADAPTERS].join(", ")}`,
    );
  }
  requireString(site, "publication.workflowFile", site.publication?.workflowFile);
  requireString(site, "publication.schedulePath", site.publication?.schedulePath);
  requireString(site, "publication.draftDir", site.publication?.draftDir);

  // Credentials are referenced BY NAME only. A registration that carried a
  // secret value would leak it into git the moment it was committed.
  const creds = site.credentials ?? {};
  for (const [key, value] of Object.entries(creds)) {
    if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(value)) {
      throw new RegistrationError(
        site.siteId,
        `credentials.${key} must be an ENV VAR NAME, never a value`,
      );
    }
  }
  return site;
}

/** Build an indexed registry from a list, rejecting duplicates. */
export function buildRegistry(sites) {
  const byId = new Map();
  const byLane = new Map();
  for (const site of sites) {
    validateRegistration(site);
    if (byId.has(site.siteId)) {
      throw new RegistrationError(site.siteId, "duplicate siteId in registry");
    }
    if (byLane.has(site.laneKey)) {
      throw new RegistrationError(site.siteId, `duplicate laneKey: ${site.laneKey}`);
    }
    byId.set(site.siteId, site);
    byLane.set(site.laneKey, site);
  }
  return {
    all: () => [...byId.values()],
    ids: () => [...byId.keys()],
    get(siteId) {
      const site = byId.get(siteId);
      if (!site) {
        throw new RegistrationError(siteId, "not registered, enrol it in the registry first");
      }
      return site;
    },
    getByLane(laneKey) {
      const site = byLane.get(laneKey);
      if (!site) {
        throw new RegistrationError(laneKey, "no registered site owns this lane");
      }
      return site;
    },
    has: (siteId) => byId.has(siteId),
  };
}
