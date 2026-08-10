/**
 * Image acquisition.
 *
 * A real Pexels client with the provider behind an interface so the whole path
 * is testable from recorded fixtures without a credential. The estate's
 * intended contract is Pexels; a site may opt out only by declaring
 * `provider: "repo-hosted"` with a written reason in its registration, which
 * makes the exception visible instead of hidden in a fork.
 *
 * The qirofit 2026-08-08 article shipped `/photos/modality-cupping.jpg`, a
 * repo-hosted asset. That is legitimate ONLY as a declared policy, it is not
 * evidence that Pexels acquisition works, and this module never lets the two be
 * confused: acquired images carry `provider` and the proof records it.
 */

const PEXELS_SEARCH_ENDPOINT = "https://api.pexels.com/v1/search";

export class ImageAcquisitionError extends Error {
  constructor(message, detail, code = "IMAGE_ACQUISITION_FAILED") {
    super(message);
    this.name = "ImageAcquisitionError";
    this.detail = detail;
    this.code = code;
  }
}

/**
 * Preflight the credential BEFORE any work is done.
 *
 * Without this the absence of a credential surfaces as an opaque authorization
 * error deep inside a run, after generation has already spent a model call. The
 * production workflows referenced no secrets at all, so this was the actual
 * failure every lane would have hit: worth naming precisely rather than
 * discovering at the HTTP layer.
 *
 * Presence is all that is checked. The value is never read, compared, logged or
 * returned.
 */
export function preflightImageCredentials(site, env = process.env, apiKeyEnv = "PEXELS_API_KEY") {
  if (!site?.imagePolicy?.required) {
    return { ok: true, provider: null, reason: "image not required by policy" };
  }
  if (site.imagePolicy.provider === "repo-hosted") {
    return { ok: true, provider: "repo-hosted", reason: "declared repo-hosted policy" };
  }
  if (!env[apiKeyEnv]?.trim()) {
    return {
      ok: false,
      code: "MISSING_PEXELS_CREDENTIAL",
      provider: "pexels",
      reason:
        `${apiKeyEnv} is not present in the execution environment. The canonical publish ` +
        "workflow must pass it through as a secret reference; no publication may proceed.",
    };
  }
  return { ok: true, provider: "pexels", reason: "credential present" };
}

/** Deterministic, collision-resistant filename derived from slug + photo id. */
export function imageFilename({ slug, photoId, contentType }) {
  const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60);
  return `${safeSlug}-${photoId}.${ext}`;
}

function pickPhotoUrl(photo) {
  return photo?.src?.large2x ?? photo?.src?.large ?? photo?.src?.landscape ?? photo?.src?.original ?? null;
}

/**
 * Real Pexels client. `fetchImpl` is injected so tests drive it from recorded
 * responses; nothing about the request shape changes between test and live.
 */
export function createPexelsProvider({ apiKeyEnv = "PEXELS_API_KEY", fetchImpl = fetch } = {}) {
  return {
    id: "pexels",
    licence: "Pexels License",

    /** True when this provider can actually reach the API right now. */
    isAvailable() {
      return Boolean(process.env[apiKeyEnv]?.trim());
    },

    async search({ query, perPage = 8 }) {
      const apiKey = process.env[apiKeyEnv]?.trim();
      if (!apiKey) {
        throw new ImageAcquisitionError(
          `${apiKeyEnv} is not set; live Pexels acquisition unavailable.`,
          null,
          "MISSING_PEXELS_CREDENTIAL",
        );
      }
      const url = new URL(PEXELS_SEARCH_ENDPOINT);
      url.searchParams.set("query", query);
      url.searchParams.set("orientation", "landscape");
      url.searchParams.set("size", "large");
      url.searchParams.set("per_page", String(perPage));

      const response = await fetchImpl(url, { headers: { Authorization: apiKey } });
      if (!response.ok) {
        throw new ImageAcquisitionError(`Pexels search returned ${response.status}.`);
      }
      const payload = await response.json();
      return payload.photos ?? [];
    },

    async download(url) {
      const response = await fetchImpl(url);
      if (!response.ok) {
        throw new ImageAcquisitionError(`Pexels download returned ${response.status}.`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      const buffer = Buffer.from(await response.arrayBuffer());
      return { buffer, contentType: contentType.split(";")[0].trim() };
    },
  };
}

/**
 * Acquire one image for an article.
 *
 * Returns a descriptor carrying everything validation and proof need, never a
 * bare URL, because a URL alone cannot be checked for type, size or provenance.
 */
export async function acquireImage({ site, article, provider, store, minWidth = 1200 }) {
  const policy = site.imagePolicy;

  if (!policy.required) {
    return { status: "not-required", image: null };
  }

  if (policy.provider === "repo-hosted") {
    // A declared exception. It is recorded as such and must never be reported
    // as a Pexels acquisition.
    if (typeof policy.repoAsset !== "string" || !policy.repoAsset.startsWith("/")) {
      throw new ImageAcquisitionError(
        `${site.siteId} declares repo-hosted images but no repoAsset path.`,
      );
    }
    return {
      status: "repo-hosted",
      image: {
        url: policy.repoAsset,
        alt: `${article.title} illustration`,
        provider: "repo-hosted",
        licence: policy.optOutReason,
      },
    };
  }

  const query = [article.imageQuery, policy.queryHint].filter(Boolean).join(" ").slice(0, 200);
  const photos = await provider.search({ query });
  if (photos.length === 0) {
    throw new ImageAcquisitionError(`No image found for "${query}".`, { siteId: site.siteId, query });
  }

  const candidate = photos.find((photo) => {
    const url = pickPhotoUrl(photo);
    return Boolean(url) && (photo.width ?? Infinity) >= minWidth;
  });
  if (!candidate) {
    throw new ImageAcquisitionError(
      `No candidate met the ${minWidth}px minimum for "${query}".`,
      { siteId: site.siteId, candidates: photos.length },
    );
  }

  const sourceUrl = pickPhotoUrl(candidate);
  const { buffer, contentType } = await provider.download(sourceUrl);
  const filename = imageFilename({ slug: article.slug, photoId: candidate.id, contentType });

  // Storage is injected so a dry run exercises the identical path without
  // writing into a repo.
  const stored = await store.put({ filename, buffer, contentType });

  const alt = candidate.alt?.trim();
  return {
    status: "acquired",
    image: {
      url: stored.publicPath,
      alt: alt && alt.length >= 15 ? alt : `${article.title}, related photograph`,
      provider: "pexels",
      photographer: candidate.photographer ?? "Pexels",
      photographerUrl: candidate.photographer_url ?? null,
      sourceUrl,
      licence: provider.licence,
      contentType,
      byteLength: buffer.length,
      width: candidate.width ?? null,
      height: candidate.height ?? null,
      filename,
    },
  };
}

/** In-memory store for dry runs and tests. Never touches a repository. */
export function createMemoryStore({ publicPrefix = "/photos" } = {}) {
  const files = new Map();
  return {
    id: "memory",
    async put({ filename, buffer, contentType }) {
      if (files.has(filename)) {
        throw new ImageAcquisitionError(`Refusing to overwrite existing asset ${filename}.`);
      }
      files.set(filename, { buffer, contentType });
      return { publicPath: `${publicPrefix}/${filename}`, bytes: buffer.length };
    },
    get: (filename) => files.get(filename),
    size: () => files.size,
  };
}
