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
 * is the same interface against an API. Site registrations never name a model, * provider choice is a pipeline-level decision, not site configuration.
 *
 * FAIL CLOSED
 *
 * There is no template fallback. If generation or validation fails the pipeline
 * stops. Silent fallback to synthetic prose is precisely how an estate ends up
 * believing it has a writer when it does not.
 */

import { slugify } from "./validators.js";

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
    '{"title":"","metaDescription":"","body":"","imageQuery":""}',
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
export function buildRepairPrompt({ basePrompt, previous, issues }) {
  return [
    basePrompt,
    "",
    "── YOUR PREVIOUS ATTEMPT WAS REJECTED ──",
    "",
    "It broke these rules:",
    ...issues.map((i) => `- [${i.code}] ${i.message}`),
    "",
    "Your previous output was:",
    JSON.stringify(
      {
        title: previous.title,
        metaDescription: previous.metaDescription,
        imageQuery: previous.imageQuery,
        body: `${previous.body.slice(0, 600)}…`,
      },
      null,
      1,
    ),
    "",
    "Produce a corrected version that fixes every listed rule and keeps everything",
    "else that was already acceptable. Return the same JSON object shape.",
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
  for (const key of ["title", "metaDescription", "body", "imageQuery"]) {
    if (typeof parsed[key] !== "string") {
      throw new GenerationError(`Model response is missing "${key}".`, Object.keys(parsed).join(","));
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
    async complete(prompt, { timeoutMs = 600_000 } = {}) {
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
            format: {
              type: "object",
              properties: {
                title: { type: "string" },
                metaDescription: { type: "string" },
                body: { type: "string" },
                imageQuery: { type: "string" },
              },
              required: ["title", "metaDescription", "body", "imageQuery"],
            },
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
      body: parsed.body.trim(),
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
