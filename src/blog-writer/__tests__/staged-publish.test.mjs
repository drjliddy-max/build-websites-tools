/**
 * C56: protection-safe "staged" publication.
 *
 * A protected default branch with a required status check refuses a direct push from a GITHUB_TOKEN
 * publisher (participation-effect-site run 38099821039, GH006). The staged mode pushes to a temporary
 * branch, waits for the required contexts on that exact SHA, then fast-forwards the default branch.
 * GitHub's acceptance of that fast-forward was proven in an isolated protected repo (run 38404319076);
 * these tests pin the publisher's side of the contract: call order, fail-closed paths, and that "direct"
 * (the default) is unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRepoOwnedPublisher, judgeRequiredStatuses, PublicationError } from "../publisher.js";

const SHA = "abc123def4567890abc123def4567890abc12345";
const BASE_SITE = {
  siteId: "participation-effect",
  domain: "www.theparticipationeffect.com",
  laneKey: "blog-writer-book",
  repository: { owner: "drjliddy-max", name: "participation-effect-site" },
  blogPath: "/blog",
  publication: { schedulePath: "blog-schedule.json" },
};
const STAGED_SITE = { ...BASE_SITE, publication: { ...BASE_SITE.publication, publishMode: "staged" } };
const ARTICLE = {
  title: "Why affirmations do not work",
  slug: "why-affirmations-do-not-work",
  metaDescription: "A specific and useful description of the article contents for search engines.",
  body: "## One\n\nBody.\n\n## Two\n\nMore.",
  keyword: "why affirmations don't work",
  supportingKeywords: [],
};
const SCHEDULE = { published: [], queue: [{ slug: ARTICLE.slug, title: "Planned", target_date: "2026-10-22" }] };
const CALL = { article: ARTICLE, image: null, occurrence: "2026-10-22", idempotencyKey: "blog-writer-book:2026-10-22:1" };

function harness({ statuses = [[{ context: "Vercel", state: "success" }]], failOn = null, budgetMs = 60_000 } = {}) {
  const files = new Map([["blog-schedule.json", JSON.stringify(SCHEDULE)]]);
  const log = [];
  let clock = Date.parse("2026-10-22T08:13:00Z");
  let reads = 0;
  const git = async (args) => {
    const line = args.join(" ");
    log.push(line);
    if (failOn && line.startsWith(failOn)) throw new Error(`${failOn} rejected`);
    switch (args[0]) {
      case "remote": return "https://github.com/drjliddy-max/participation-effect-site.git";
      case "status": return "";
      case "rev-parse": return args.includes("--abbrev-ref") ? "main" : SHA;
      case "diff": return [...files.keys()].join("\n");
      default: return "";
    }
  };
  const fs = {
    readFile: async (p) => { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p); },
    writeFile: async (p, d) => { files.set(p, d); },
    mkdir: async () => {},
    rm: async (p) => { files.delete(p); },
  };
  const statusReader = async ({ owner, name, sha }) => {
    assert.equal(`${owner}/${name}`, "drjliddy-max/participation-effect-site");
    assert.equal(sha, SHA, "statuses are read for the exact staged SHA");
    const out = statuses[Math.min(reads, statuses.length - 1)];
    reads += 1;
    if (out instanceof Error) throw out;
    return out;
  };
  const publisher = createRepoOwnedPublisher({
    git, fs, runGate: async () => {},
    now: () => new Date(clock),
    statusReader,
    sleep: async (ms) => { clock += ms; },
    previewPolicy: { budgetMs, intervalMs: 15_000 },
  });
  return { publisher, log, reads: () => reads };
}

const STAGE_REF = `HEAD:refs/heads/blog-writer/stage-${SHA.slice(0, 12)}`;
const DELETE_STAGE = `push origin --delete blog-writer/stage-${SHA.slice(0, 12)}`;

test("direct (default) mode is unchanged: one push straight to the default branch, no status reads", async () => {
  const h = harness();
  const out = await h.publisher.publish({ ...CALL, site: BASE_SITE });
  assert.equal(out.publishMode, "direct");
  assert.equal(out.stagedVia, null);
  assert.ok(h.log.includes("push origin main"));
  assert.ok(!h.log.some((l) => l.includes("refs/heads/blog-writer/stage-")));
  assert.equal(h.reads(), 0);
});

test("staged: push staging branch, wait for Vercel=success on that SHA, fast-forward main, delete staging", async () => {
  const h = harness({ statuses: [[], [{ context: "Vercel", state: "pending" }], [{ context: "Vercel", state: "success" }]] });
  const out = await h.publisher.publish({ ...CALL, site: STAGED_SITE });
  const pushes = h.log.filter((l) => l.startsWith("push"));
  assert.deepEqual(pushes, [`push origin ${STAGE_REF}`, "push origin HEAD:main", DELETE_STAGE]);
  assert.ok(!h.log.includes("push origin main"), "never a direct push to main in staged mode");
  assert.equal(out.commitSha, SHA, "the SHA that reaches main is the staged SHA");
  assert.equal(out.publishMode, "staged");
  assert.equal(out.stagedVia, `blog-writer/stage-${SHA.slice(0, 12)}`);
  assert.equal(h.reads(), 3);
});

test("staged: Vercel=failure never moves main; staging deleted and local commit reverted", async () => {
  const h = harness({ statuses: [[{ context: "Vercel", state: "failure" }]] });
  await assert.rejects(h.publisher.publish({ ...CALL, site: STAGED_SITE }),
    (e) => e instanceof PublicationError && e.stage === "preview" && /failed: Vercel/.test(e.message));
  assert.ok(!h.log.includes("push origin HEAD:main"));
  assert.ok(h.log.includes(DELETE_STAGE));
  assert.ok(h.log.includes("reset --hard HEAD~1"));
});

test("staged: a status that never arrives times out closed (no promotion)", async () => {
  const h = harness({ statuses: [[{ context: "Vercel", state: "pending" }]], budgetMs: 60_000 });
  await assert.rejects(h.publisher.publish({ ...CALL, site: STAGED_SITE }),
    (e) => e.stage === "preview" && /not success within 60000ms: Vercel/.test(e.message));
  assert.ok(!h.log.includes("push origin HEAD:main"));
  assert.ok(h.log.includes("reset --hard HEAD~1"));
});

test("staged: an unreadable status API is treated as pending, so it also fails closed", async () => {
  const h = harness({ statuses: [new Error("HTTP 502")], budgetMs: 30_000 });
  await assert.rejects(h.publisher.publish({ ...CALL, site: STAGED_SITE }), (e) => e.stage === "preview");
  assert.ok(!h.log.includes("push origin HEAD:main"));
});

test("staged: a refused fast-forward (main moved) reverts and cleans up, stage 'promote'", async () => {
  const h = harness({ failOn: "push origin HEAD:main" });
  await assert.rejects(h.publisher.publish({ ...CALL, site: STAGED_SITE }), (e) => e.stage === "promote");
  assert.ok(h.log.includes(DELETE_STAGE));
  assert.ok(h.log.includes("reset --hard HEAD~1"));
});

test("staged: a failed staging push reverts without reading statuses, stage 'stage'", async () => {
  const h = harness({ failOn: `push origin ${STAGE_REF}` });
  await assert.rejects(h.publisher.publish({ ...CALL, site: STAGED_SITE }), (e) => e.stage === "stage");
  assert.equal(h.reads(), 0);
  assert.ok(h.log.includes("reset --hard HEAD~1"));
});

test("required contexts are matched exactly and every one must be success", () => {
  assert.equal(judgeRequiredStatuses([{ context: "Vercel - Preview", state: "success" }], ["Vercel"]).verdict, "pending");
  assert.equal(judgeRequiredStatuses([{ context: "Vercel", state: "success" }], ["Vercel", "Build"]).verdict, "pending");
  assert.equal(judgeRequiredStatuses([{ context: "Vercel", state: "error" }], ["Vercel"]).verdict, "failed");
  assert.equal(judgeRequiredStatuses([{ context: "Vercel", state: "success" }, { context: "Build", state: "success" }], ["Vercel", "Build"]).verdict, "success");
  // GitHub lists newest first; a later failure after an older success must win.
  assert.equal(judgeRequiredStatuses([{ context: "Vercel", state: "failure" }, { context: "Vercel", state: "success" }], ["Vercel"]).verdict, "failed");
});

// ── registration: publishMode is opt-in and validated ──────────────────────────────────────────
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateRegistration, RegistrationError } from "../registry.js";
const QIROFIT = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/qirofit-site.config.json", import.meta.url)), "utf8"));
const withPublication = (extra) => ({ ...QIROFIT, publication: { ...QIROFIT.publication, ...extra } });

test("registration: publishMode defaults to direct (absent is valid) and accepts staged", () => {
  assert.equal(validateRegistration(QIROFIT).siteId, QIROFIT.siteId);
  assert.doesNotThrow(() => validateRegistration(withPublication({ publishMode: "direct" })));
  assert.doesNotThrow(() => validateRegistration(withPublication({ publishMode: "staged", requiredContexts: ["Vercel"] })));
});

test("registration: an unknown publishMode or malformed requiredContexts is refused", () => {
  assert.throws(() => validateRegistration(withPublication({ publishMode: "auto" })), RegistrationError);
  assert.throws(() => validateRegistration(withPublication({ requiredContexts: [] })), RegistrationError);
  assert.throws(() => validateRegistration(withPublication({ requiredContexts: ["Vercel", ""] })), RegistrationError);
  assert.throws(() => validateRegistration(withPublication({ requiredContexts: "Vercel" })), RegistrationError);
});
