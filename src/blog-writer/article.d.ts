// Type declarations for blog-writer/article.js - the canonical article-data
// contract (BLOG_ARTICLE_PUBLICATION_CONTRACT v1) shared by every consumer site.
// See article.js for behaviour and the production incident that motivated it.

export const CANONICAL_HERO_KEY: "image_url";

export interface HeroKeys {
  readonly url: "image_url";
  readonly alt: "image_alt";
  readonly provider: "image_provider";
  readonly credit: "image_credit";
}
export const HERO_KEYS: HeroKeys;

/** Front-matter attributes are a flat string map by construction. */
export type ArticleAttributes = Record<string, string>;

export interface ParsedArticle {
  attributes: ArticleAttributes;
  body: string;
}

export interface HeroImage {
  url: string;
  alt: string;
  provider: string | null;
  credit: string | null;
}

export interface ArticleIssue {
  code: "missing-field" | "hero-missing" | "hero-contaminated";
  field: string;
  message: string;
}

export interface ArticleValidation {
  ok: boolean;
  issues: ArticleIssue[];
  hero: HeroImage | null;
}

export function parseArticleFrontmatter(source: string): ParsedArticle;

/** Returns null when no hero is declared. Throws when the URL is quote-contaminated. */
export function resolveHeroImage(attributes?: ArticleAttributes): HeroImage | null;

export function validateArticleAttributes(
  attributes?: ArticleAttributes,
  options?: { imageRequired?: boolean },
): ArticleValidation;
