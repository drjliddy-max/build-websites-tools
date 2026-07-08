// Type declarations for related-content.js - the reusable related-content /
// internal-linking selection helpers for the build-websites-template fleet.
// See related-content.js for behaviour and rationale.

export interface ScheduleEntryLike {
  slug: string;
  title: string;
  cluster?: string;
  [key: string]: unknown;
}

export interface ServiceLink {
  href: string;
  label: string;
}

export interface RelatedContentLimits {
  relatedArticles?: number;
  relatedServices?: number;
  featuredPosts?: number;
  serviceEducation?: number;
}

export interface RelatedContentConfig {
  /** Caps per selection. Defaults: 3 / 2 / 3 / 6. */
  limits?: RelatedContentLimits;
  /** cluster key -> local-intent service/page links for that topic. */
  clusterServices?: Record<string, ServiceLink[]>;
  /** Fallback service links when a post has no cluster / no cluster mapping. */
  defaultServices?: ServiceLink[];
  /** Priority slugs for service-page education + featured fallback. */
  cornerstoneSlugs?: string[];
  /** Explicit priority slugs for homepage featured posts. */
  featuredSlugs?: string[];
  /** When a cluster has fewer siblings than the limit, fill from other
   *  published posts (deterministic order). Default true. */
  fillAcrossClusters?: boolean;
  /** Per-slug explicit overrides (highest priority). */
  overrides?: {
    relatedPostsBySlug?: Record<string, string[]>;
    servicesBySlug?: Record<string, ServiceLink[]>;
  };
}

export function selectRelatedPosts(
  currentSlug: string,
  published: ScheduleEntryLike[],
  config?: RelatedContentConfig,
): ScheduleEntryLike[];

export function relatedServices(
  cluster: string | null | undefined,
  config?: RelatedContentConfig,
  currentSlug?: string,
): ServiceLink[];

export function featuredPosts(
  published: ScheduleEntryLike[],
  config?: RelatedContentConfig,
): ScheduleEntryLike[];

export function servicePageEducationLinks(
  published: ScheduleEntryLike[],
  config?: RelatedContentConfig,
): ScheduleEntryLike[];
