/**
 * Article generation. The stage that did not previously exist.
 *
 * Before this module every article in the estate was hand-authored and the
 * "writer" in site-monitor was a template filler with no model behind it. The
 * constraints the publisher enforces were therefore discovered after authoring,
 * by hand. Here they are supplied to the model up front AND re-checked
 * deterministically afterwards, because a model asserting it obeyed a rule is
 * not evidence that it did.
 *
 * PROVIDER BOUNDARY
 *
 * Providers are injected. `local` drives the operator's Ollama instance and
 * needs no hosted credential, which is what makes this provable today; `hosted`
 * is the same interface against an API. Site registrations never name a model:
 * provider choice is a pipeline-level decision, not site configuration.
 *
 * FAIL CLOSED
 *
 * There is no template fallback. If generation or validation fails the pipeline
 * stops. Silent fallback to synthetic prose is precisely how an estate ends up
 * believing it has a writer when it does not.
 */

import { slugify, MIN_H2_COUNT, BODY_MIN_WORDS } from "./validators.js";

/**
 * The response contract.
 *
 * `body` used to be a free string with the structure requested in prose. Models
 * complied inconsistently: observed runs returned well-formed JSON, clean
 * endings, and h2=0, which then failed `structure` in the validator. Asking
 * more politely does not fix a contract that cannot express the requirement.
 *
 * Sections are now first-class. The schema requires at least MIN_H2_COUNT of
 * them, each with a heading and prose, and the markdown body is ASSEMBLED here
 * rather than transcribed from the model. Heading count and non-empty sections
 * therefore cannot be violated by a compliant response, because the generator
 * writes the "## " markers itself.
 */
export const ARTICLE_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    metaDescription: { type: "string" },
    introduction: { type: "string" },
    sections: {
      type: "array",
      minItems: MIN_H2_COUNT,
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          body: { type: "string" },
        },
        required: ["heading", "body"],
      },
    },
    imageQuery: { type: "string" },
  },
  required: ["title", "metaDescription", "introduction", "sections", "imageQuery"],
};

/** Assemble markdown from the structured response. The generator owns the H2s. */
export function assembleBody({ introduction, sections }) {
  const parts = [introduction.trim()];
  for (const section of sections) {
    parts.push(`## ${section.heading.trim()}`);
    parts.push(section.body.trim());
  }
  return parts.filter(Boolean).join("\n\n");
}

export class GenerationError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "GenerationError";
    this.detail = detail;
  }
}

/**
 * Build the instruction from the site's registered context. Nothing here is
 * site-coded: every site-specific value arrives through `site`.
 */
export function buildPrompt({ site, keyword, supportingKeywords = [], occurrence, history, constraints }) {
  const ctx = site.contentContext;
  const prohibited = [...new Set([...(ctx.prohibitedTerms ?? [])])];

  return [
    `You are writing one article for ${site.domain}.`,
    "",
    `AUDIENCE: ${ctx.audience}`,
    `VOICE: ${ctx.voice}`,
    ctx.expertise ? `EXPERTISE ANCHOR: ${ctx.expertise}` : null,
    "",
    `PRIMARY KEYWORD: ${keyword}`,
    supportingKeywords.length ? `SUPPORTING KEYWORDS: ${supportingKeywords.join("; ")}` : null,
    `PUBLICATION DATE: ${occurrence}`,
    "",
    "HARD CONSTRAINTS. Output violating any of these is rejected:",
    `- title: ${constraints.titleMin}-${constraints.titleMax} characters, no trailing period`,
    `- metaDescription: ${constraints.metaMin}-${constraints.metaMax} characters`,
    `- body: ${constraints.bodyMinWords}-${constraints.bodyMaxWords} words of Markdown`,
    `- body: at least ${constraints.minH2Count} '## ' sections, and NO '# ' H1`,
    "- body must end on a complete sentence",
    "- use the primary keyword naturally in the title and the opening paragraph",
    "- no placeholder text, no TODO, no bracketed instructions",
    prohibited.length
      ? `- these words and phrases are FORBIDDEN anywhere: ${prohibited.join(", ")}`
      : null,
    "- forbidden everywhere: cure, cures, guarantee, guaranteed, miracle, clinically proven, FDA approved",
    "- make no claim you cannot support; do not invent statistics, studies, names, or outcomes",
    "",
    history.titles.length
      ? `ALREADY PUBLISHED. Do not repeat or near-duplicate these topics:\n${history.titles.map((t) => `- ${t}`).join("\n")}`
      : null,
    "",
    "Return ONE JSON object and nothing else, with exactly these keys:",
    '{"title":"","metaDescription":"","introduction":"","sections":[{"heading":"","body":""}],"imageQuery":""}',
    "",
    `sections: at least ${constraints.minH2Count} entries. Each needs a distinct heading and`,
    "  several sentences of real prose. Do NOT write '## ' yourself: headings come from the",
    "  heading field and the markdown is assembled for you.",
    "introduction: the opening paragraphs, before the first heading.",
    `The introduction and all section bodies together must total ${constraints.bodyMinWords}-${constraints.bodyMaxWords} words,`,
    `so aim for roughly ${Math.ceil(constraints.bodyMinWords / constraints.minH2Count)}+ words per section.`,
    "imageQuery: 3-8 plain words describing a photograph to accompany the article.",
    "Do not wrap the JSON in Markdown fences.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Re-prompt after a deterministic validation failure.
 *
 * The model is told exactly which rules it broke and given its own previous
 * output to repair. This is bounded. The pipeline caps attempts and then fails
 * closed. It is NOT a fallback: a repair that still fails validation publishes
 * nothing.
 */
export const CORRECTION_INSTRUCTIONS = {
  "body-too-short": (issue) =>
    `LENGTH: the article was ${issue.detail} words, below the ${BODY_MIN_WORDS} minimum. ` +
    `Add substantive material to the EXISTING sections or add another section. Do not pad with restatement.`,
  "body-too-long": () => "LENGTH: the article is too long. Tighten, do not delete a whole section.",
  structure: (issue) =>
    `STRUCTURE: only ${issue.detail ?? "too few"} sections were usable. Return at least ` +
    `${MIN_H2_COUNT} entries in "sections", each with a distinct heading and real prose.`,
  "truncated-body": () => "TERMINATION: the last section stopped mid-sentence. Finish it.",
  "topic-drift": (issue) =>
    `TOPIC: the article did not cover its assigned keyword "${issue.detail}". Rewrite so the ` +
    `keyword is the actual subject, used naturally in the title and opening paragraph.`,
  "prohibited-term": (issue) =>
    `FORBIDDEN WORDING: "${issue.detail}" is not permitted on this site. Express the idea ` +
    `differently. Do NOT simply delete the word and leave a sentence that no longer makes sense.`,
  "title-length": (issue) =>
    `TITLE: ${issue.detail} characters. Rewrite it to fit the stated range, no trailing period.`,
  "meta-length": (issue) =>
    `META DESCRIPTION: ${issue.detail} characters. Rewrite it to fit the stated range.`,
  "duplicate-title": () => "DUPLICATE: that title is already published. Choose a different angle.",
  "duplicate-slug": () => "DUPLICATE: that slug is already published. Choose a different angle.",
  "placeholder-residue": () => "PLACEHOLDER: remove template or model residue and write the real text.",
};

/**
 * Re-prompt after a deterministic validation failure.
 *
 * Each failure code maps to a TYPED correction naming the measured quantity, so
 * the retry targets the condition that actually failed instead of re-rolling the
 * same request. Raw validator objects are never handed to the model.
 *
 * Bounded: the pipeline caps attempts and then fails closed. A correction is
 * never permission to relax a requirement.
 */
export function buildRepairPrompt({ basePrompt, previous, issues }) {
  const corrections = issues.map((issue) => {
    const build = CORRECTION_INSTRUCTIONS[issue.code];
    return `- ${build ? build(issue) : issue.message}`;
  });
  return [
    basePrompt,
    "",
    "YOUR PREVIOUS ATTEMPT WAS REJECTED. Fix exactly these problems:",
    ...corrections,
    "",
    "Keep everything that was already acceptable. Previous attempt, for reference:",
    JSON.stringify(
      {
        title: previous.title,
        metaDescription: previous.metaDescription,
        imageQuery: previous.imageQuery,
        bodyExcerpt: `${previous.body.slice(0, 500)}...`,
      },
      null,
      1,
    ),
    "",
    "Return the same JSON object shape.",
  ].join("\n");
}

/** Extract the JSON object from a model response that may carry stray prose. */
export function parseModelJson(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new GenerationError("Model returned an empty response.");
  }
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    text = fence[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new GenerationError("Model response contained no JSON object.", raw.slice(0, 400));
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new GenerationError(`Model response was not valid JSON: ${error.message}`, raw.slice(0, 400));
  }
  for (const key of ["title", "metaDescription", "introduction", "imageQuery"]) {
    if (typeof parsed[key] !== "string") {
      throw new GenerationError(`Model response is missing "${key}".`, Object.keys(parsed).join(","));
    }
  }
  if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    throw new GenerationError("Model response has no sections.", Object.keys(parsed).join(","));
  }
  for (const [index, section] of parsed.sections.entries()) {
    if (typeof section?.heading !== "string" || section.heading.trim() === "") {
      throw new GenerationError(`Section ${index + 1} has no heading.`);
    }
    if (typeof section?.body !== "string" || section.body.trim() === "") {
      throw new GenerationError(`Section ${index + 1} ("${section.heading}") has no body.`);
    }
  }
  return parsed;
}

/**
 * Ollama provider. The local lane. Requires no hosted credential, which is why
 * the generator is provable on this machine today.
 */
export function createLocalProvider({ model = "phi4:14b", endpoint = "http://127.0.0.1:11434", fetchImpl = fetch } = {}) {
  return {
    id: "local",
    model,
    async complete(prompt, { timeoutMs = 600_000, schema = ARTICLE_RESPONSE_SCHEMA } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${endpoint}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt,
            stream: false,
            // A JSON SCHEMA, not merely "json". Asking a mid-size local model to
            // remember four key names across a long prompt loses a field often
            // enough to matter; constraining decoding makes the shape mechanical
            // instead of hoped-for. Validation still runs afterwards.
            // Constrained decoding against the article contract. The section
            // array is what makes heading structure mechanical rather than
            // hoped-for.
            format: schema,
            options: { temperature: 0.7, num_predict: 4096 },
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new GenerationError(`Local model returned ${response.status}.`);
        }
        const payload = await response.json();
        return payload.response ?? "";
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Hosted provider, same interface, an API behind it. The key is read from the
 * environment BY NAME at call time and never logged, echoed, or stored on the
 * returned object.
 */
export function createHostedProvider({ model, endpoint, apiKeyEnv, fetchImpl = fetch }) {
  if (!model || !endpoint || !apiKeyEnv) {
    throw new GenerationError("Hosted provider needs model, endpoint and apiKeyEnv.");
  }
  return {
    id: "hosted",
    model,
    /** Routing skips an unavailable provider rather than failing the run. */
    isAvailable() {
      return Boolean(process.env[apiKeyEnv]?.trim());
    },
    async complete(prompt, { timeoutMs = 300_000 } = {}) {
      const apiKey = process.env[apiKeyEnv]?.trim();
      if (!apiKey) {
        throw new GenerationError(`${apiKeyEnv} is not set; hosted generation unavailable.`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 4096,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          // Status only. A provider error body can echo the request.
          throw new GenerationError(`Hosted model returned ${response.status}.`);
        }
        const payload = await response.json();
        return payload.content?.[0]?.text ?? "";
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Generate one article. Returns structured output plus generation metadata; it
 * does NOT validate. The caller runs `validateArticle` so that generation can
 * never mark its own work acceptable.
 */
/**
 * Route generation across an ordered provider list.
 *
 * `liddy` exhausted its retries on two local models without ever producing a
 * body that met the length and structure rules. The answer is a stronger
 * provider, not a weaker validator: the constraints describe what a publishable
 * article is, and lowering them to fit a 12B model would publish worse articles
 * on all seven sites.
 *
 * Each provider gets the full repair budget before the next is tried. A
 * provider that cannot run at all (missing credential) is skipped and recorded,
 * so an absent hosted key degrades the route rather than failing the run.
 */
export async function generateWithProviderRouting({ providers, ...args }) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new GenerationError("Provider routing needs at least one provider.");
  }
  const route = [];
  let lastError = null;

  for (const provider of providers) {
    if (typeof provider.isAvailable === "function" && !provider.isAvailable()) {
      route.push({ providerId: provider.id, model: provider.model, outcome: "unavailable" });
      continue;
    }
    try {
      const article = await generateArticle({ ...args, provider });
      return {
        ...article,
        generation: { ...article.generation, route: [...route, { providerId: provider.id, model: provider.model, outcome: "accepted" }] },
      };
    } catch (error) {
      lastError = error;
      route.push({
        providerId: provider.id,
        model: provider.model,
        outcome: "rejected",
        reason: error.message,
      });
    }
  }

  throw new GenerationError(
    `All ${providers.length} provider(s) failed to produce a valid article. ` +
      `Route: ${route.map((r) => `${r.providerId}:${r.outcome}`).join(" -> ")}`,
    { route, lastError: lastError?.message ?? null },
  );
}

export async function generateArticle({
  site,
  keyword,
  supportingKeywords = [],
  occurrence,
  history = { slugs: [], titles: [] },
  provider,
  constraints,
  validate,
  maxAttempts = 3,
}) {
  if (!provider || typeof provider.complete !== "function") {
    throw new GenerationError("A provider with complete() is required.");
  }
  const basePrompt = buildPrompt({ site, keyword, supportingKeywords, occurrence, history, constraints });
  const startedAt = new Date().toISOString();
  const attempts = [];
  let prompt = basePrompt;
  let article = null;
  let lastIssues = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const parsed = parseModelJson(await provider.complete(prompt));
    article = {
      title: parsed.title.trim(),
      slug: slugify(parsed.title),
      metaDescription: parsed.metaDescription.trim(),
      body: assembleBody(parsed),
      imageQuery: parsed.imageQuery.trim(),
      keyword,
      supportingKeywords,
    };

    // No validator supplied means the caller validates; return the first draft.
    if (typeof validate !== "function") {
      lastIssues = null;
      attempts.push({ attempt, issues: null });
      break;
    }

    const result = validate(article);
    attempts.push({ attempt, issues: result.ok ? null : result.issues.map((i) => i.code) });
    if (result.ok) {
      lastIssues = null;
      break;
    }
    lastIssues = result.issues;
    prompt = buildRepairPrompt({ basePrompt, previous: article, issues: result.issues });
  }

  if (lastIssues) {
    throw new GenerationError(
      `Generation failed validation after ${maxAttempts} attempts: ` +
        lastIssues.map((i) => i.code).join(", "),
      lastIssues,
    );
  }

  return {
    ...article,
    generation: {
      providerId: provider.id,
      model: provider.model,
      promptChars: basePrompt.length,
      attempts: attempts.length,
      attemptLog: attempts,
      startedAt,
      completedAt: new Date().toISOString(),
    },
  };
}
