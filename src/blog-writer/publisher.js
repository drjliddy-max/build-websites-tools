/**
 * The production publication adapter.
 *
 * Derived from the seven working lanes, not invented. All seven publish the same
 * way: the site renders from `.siteclinic/automation/<lane>/drafts/*.md`, so
 * publishing means writing the draft, moving the queue row into `published`,
 * writing a proof file, and committing all three. Vercel deploys from the push.
 *
 * WHERE THE FORKS DISAGREED, THE STRONGER BEHAVIOUR WINS
 *
 *   gate + rollback   bmj / jeffrystein / qirofit run `gate:seo` before
 *                     committing and restore the schedule verbatim if it fails.
 *                     siteclinic / book / ada / liddy commit without it. The
 *                     gate is kept: publishing a page that fails the SEO gate is
 *                     the regression the gate exists to stop.
 *   ambiguity refusal siteclinic throws on multiple queue rows for one date.
 *                     Kept: two rows for one occurrence is unresolvable, and
 *                     guessing picks an article at random.
 *   clean worktree    NO lane checked. Added: committing from a dirty tree
 *                     sweeps unrelated work into a publication commit.
 *   commit paths      qirofit passed absolute paths where the others passed
 *                     repo-relative. Relative is correct and is used here.
 *
 * FAIL CLOSED
 *
 * Every filesystem mutation is journalled and rolled back on failure, so a
 * partial publication cannot leave the repo half-changed. No stage returns a URL
 * it has not earned.
 */

export class PublicationError extends Error {
  constructor(stage, message, detail) {
    super(message);
    this.name = "PublicationError";
    this.stage = stage;
    this.detail = detail;
  }
}

/**
 * Serialize an article to the draft format the sites render from.
 * Frontmatter keys match what the existing governance validators read.
 */
export function serializeDraft({ article, image, occurrence }) {
  const esc = (value) => String(value).replace(/"/g, '\\"');
  const lines = [
    "---",
    `title: "${esc(article.title)}"`,
    `slug: "${esc(article.slug)}"`,
    `description: "${esc(article.metaDescription)}"`,
    `target_date: "${occurrence}"`,
    `keywords: [${(article.supportingKeywords ?? []).concat(article.keyword ? [article.keyword] : []).map((k) => `"${esc(k)}"`).join(", ")}]`,
  ];
  if (image) {
    lines.push(`image_url: "${esc(image.url)}"`);
    lines.push(`image_alt: "${esc(image.alt)}"`);
    if (image.provider) lines.push(`image_provider: "${esc(image.provider)}"`);
    if (image.photographer) lines.push(`image_credit: "${esc(image.photographer)}"`);
  }
  lines.push("---", "", article.body.trim(), "");
  return lines.join("\n");
}

/**
 * The narrow site adapter surface.
 *
 * These are the ONLY questions a site may answer for itself. Everything else is
 * canonical. `assertAdapterSurface` refuses an adapter that grows beyond it, so
 * the surface cannot quietly become a seventh orchestrator.
 */
export const ADAPTER_METHODS = Object.freeze([
  "draftPath",
  "imagePath",
  "schedulePath",
  "proofPath",
  "publicUrl",
  "publicImageUrl",
]);

export function assertAdapterSurface(adapter) {
  const provided = Object.keys(adapter);
  const extra = provided.filter((key) => !ADAPTER_METHODS.includes(key));
  if (extra.length > 0) {
    throw new PublicationError(
      "adapter",
      `Site adapter may only answer ${ADAPTER_METHODS.join(", ")}. Found: ${extra.join(", ")}. ` +
        "Orchestration belongs in the canonical publisher, not in a site adapter.",
      extra,
    );
  }
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new PublicationError("adapter", `Site adapter is missing ${method}().`);
    }
  }
  return adapter;
}

/** Default adapter. Every current lane matches this shape. */
export function createDefaultAdapter(site) {
  const laneDir = `.siteclinic/automation/${site.laneKey}`;
  return {
    draftPath: (slug) => `${laneDir}/drafts/${slug}.md`,
    imagePath: (filename) => `public/photos/${filename}`,
    schedulePath: () => site.publication.schedulePath,
    proofPath: (occurrence) => `${laneDir}/proofs/${site.laneKey}_${occurrence}.json`,
    publicUrl: (slug) => `https://${site.domain}${site.blogPath}/${slug}`,
    publicImageUrl: (url) => (url.startsWith("http") ? url : `https://${site.domain}${url}`),
  };
}

/**
 * The shipped production publisher.
 *
 * `git`, `fs` and `runGate` are injected so the identical code path is driven by
 * tests and by production; there is no test-only branch inside it.
 */
export function createRepoOwnedPublisher({ git, fs, runGate, adapter, now = () => new Date() }) {
  if (!git || !fs) {
    throw new PublicationError("init", "createRepoOwnedPublisher requires git and fs.");
  }

  return {
    id: "repo-owned-github-commit",

    async publish({ site, article, image, occurrence, idempotencyKey }) {
      const site_adapter = assertAdapterSurface(adapter ?? createDefaultAdapter(site));
      const written = [];

      // ── repository identity ─────────────────────────────────────────────
      const remote = (await git(["remote", "get-url", "origin"])).trim();
      const expected = `${site.repository.owner}/${site.repository.name}`;
      if (!remote.includes(expected)) {
        throw new PublicationError(
          "repo-identity",
          `Refusing to publish ${site.siteId}: origin is "${remote}", expected ${expected}.`,
        );
      }

      // ── clean worktree ──────────────────────────────────────────────────
      // No existing lane checked this. Committing from a dirty tree sweeps
      // unrelated work into a publication commit.
      const dirty = (await git(["status", "--porcelain"])).trim();
      if (dirty) {
        throw new PublicationError(
          "worktree",
          `Refusing to publish from a dirty worktree (${dirty.split("\n").length} path(s) changed).`,
          dirty.split("\n").slice(0, 10),
        );
      }

      const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();

      // ── schedule + ambiguity refusal ────────────────────────────────────
      const schedulePath = site_adapter.schedulePath();
      const scheduleRaw = await fs.readFile(schedulePath, "utf8");
      const schedule = JSON.parse(scheduleRaw);

      const alreadyPublished = (schedule.published ?? []).filter((e) => e.target_date === occurrence);
      if (alreadyPublished.length > 0) {
        return {
          outcome: "already-published",
          slug: alreadyPublished[0].slug,
          commitSha: null,
          url: site_adapter.publicUrl(alreadyPublished[0].slug),
          idempotencyKey,
        };
      }
      const queued = (schedule.queue ?? []).filter((e) => e.target_date === occurrence);
      if (queued.length > 1) {
        throw new PublicationError(
          "queue-ambiguous",
          `${queued.length} queued rows target ${occurrence}. Refusing rather than guessing.`,
          queued.map((e) => e.slug),
        );
      }
      if ((schedule.published ?? []).some((e) => e.slug === article.slug)) {
        throw new PublicationError("duplicate-slug", `Slug "${article.slug}" is already published.`);
      }

      const rollback = async () => {
        await fs.writeFile(schedulePath, scheduleRaw, "utf8");
        for (const file of written) {
          try {
            await fs.rm(file);
          } catch {
            /* best effort: a file that never landed cannot be removed */
          }
        }
      };

      try {
        // ── write the article ─────────────────────────────────────────────
        const draftPath = site_adapter.draftPath(article.slug);
        await fs.mkdir(draftPath.replace(/\/[^/]+$/, ""), { recursive: true });
        await fs.writeFile(draftPath, serializeDraft({ article, image, occurrence }), "utf8");
        written.push(draftPath);

        // ── place the image, when the pipeline acquired bytes ─────────────
        let imagePath = null;
        if (image?.buffer && image.filename) {
          imagePath = site_adapter.imagePath(image.filename);
          await fs.mkdir(imagePath.replace(/\/[^/]+$/, ""), { recursive: true });
          await fs.writeFile(imagePath, image.buffer);
          written.push(imagePath);
        }

        // ── move the queue row into published ─────────────────────────────
        const publishDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Los_Angeles",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(now());
        // Carry the queue row's own metadata forward. Before v0.28.4 this built a
        // fresh literal, which DISCARDED every field the queue row carried that is
        // not listed below - `cluster` above all. Consumers key their public index
        // off cluster (adaauditreport-web's registry merge skips any entry whose
        // cluster it does not recognise), so dropping it published an article that
        // no index would ever list. The queue row is the site's own classification
        // of the topic; the publisher's job is to move it, not to re-invent it.
        const queuedRow = queued.find((e) => e.slug === article.slug) ?? queued[0] ?? {};
        const entry = {
          ...queuedRow,
          slug: article.slug,
          title: article.title,
          description: article.metaDescription,
          keywords: [article.keyword, ...(article.supportingKeywords ?? [])].filter(Boolean),
          target_date: occurrence,
          published: publishDate,
        };
        const next = structuredClone(schedule);
        next.published = [entry, ...(next.published ?? [])];
        next.queue = (next.queue ?? []).filter((e) => e.target_date !== occurrence);
        await fs.writeFile(schedulePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

        // ── build gate BEFORE the commit ──────────────────────────────────
        // Three lanes did this and four did not. Publishing a page that fails
        // the SEO gate is the regression the gate exists to stop.
        if (typeof runGate === "function") {
          try {
            await runGate();
          } catch (error) {
            await rollback();
            throw new PublicationError("gate", `Publication blocked by gate: ${error.message}`);
          }
        }

        // ── commit draft + schedule + image; the proof is deliberately NOT staged ──
        // FND-0005: a truthful proof records the publication's outcome, including whether this
        // very push succeeded, so it cannot exist before the commit that it describes. The old
        // sequence staged site_adapter.proofPath(occurrence) here while the reporter only wrote
        // the file after publish() returned: on a lane with no prior proof file `git add` failed
        // and blocked the first canonical publish; on a lane with a committed FAILED proof it
        // silently committed the stale artifact. Durable proof lives in the reporter's file sink
        // and, under the FND-0003 contract, in the workflow's uploaded proof artifact.
        const paths = [draftPath, schedulePath, imagePath].filter(Boolean);

        await git(["add", ...paths]);
        const staged = (await git(["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
        if (staged.length === 0) {
          await rollback();
          throw new PublicationError("commit", "Nothing staged; refusing to claim a publication.");
        }
        await git([
          "commit",
          "-m",
          `Publish ${article.slug} [${idempotencyKey}]`,
        ]);
        const commitSha = (await git(["rev-parse", "HEAD"])).trim();

        try {
          await git(["push", "origin", branch]);
        } catch (error) {
          // The commit exists locally but the remote does not have it, so no
          // deployment can follow. Reset it rather than report a publication.
          await git(["reset", "--hard", "HEAD~1"]);
          throw new PublicationError("push", `Push failed, local commit reverted: ${error.message}`);
        }

        return {
          outcome: "created",
          slug: article.slug,
          commitSha,
          branch,
          changedFiles: staged,
          draftPath,
          imagePath,
          // Where the reporter will write the durable proof AFTER this publication returns.
          // Advisory location only: not part of this commit (FND-0005).
          proofPath: site_adapter.proofPath(occurrence),
          url: site_adapter.publicUrl(article.slug),
          imageUrl: image ? site_adapter.publicImageUrl(image.url) : null,
          publishedDate: publishDate,
          idempotencyKey,
        };
      } catch (error) {
        if (!(error instanceof PublicationError)) {
          await rollback();
          throw new PublicationError("publish", error.message);
        }
        throw error;
      }
    },
  };
}
