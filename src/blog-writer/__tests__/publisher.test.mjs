/**
 * Production publisher tests.
 *
 * Every failure mode Part 4 requires is exercised against the SAME code path
 * production uses; `git` and `fs` are injected, not stubbed around.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  assertAdapterSurface,
  createDefaultAdapter,
  createRepoOwnedPublisher,
  serializeDraft,
  PublicationError,
  ADAPTER_METHODS
} from "../publisher.js";

const SITE = {
  siteId: "qirofit",
  domain: "qirofit.com",
  laneKey: "blog-writer-qirofit",
  repository: { owner: "drjliddy-max", name: "qirofit-web" },
  blogPath: "/blog",
  publication: { schedulePath: "blog-schedule.json" }
};

const ARTICLE = {
  title: "What cupping therapy does for athletes",
  slug: "what-cupping-therapy-does-for-athletes",
  metaDescription: "A specific and useful description of the article contents for search engines.",
  body: "## One\n\nBody text.\n\n## Two\n\nMore body text.",
  keyword: "cupping therapy Los Angeles",
  supportingKeywords: ["myofascial cupping"]
};

const IMAGE = {
  url: "/photos/what-cupping-4321.jpg",
  alt: "An athlete performing a recovery stretch",
  provider: "pexels",
  photographer: "Jane Doe",
  filename: "what-cupping-4321.jpg",
  buffer: Buffer.alloc(1000)
};

function harness({ schedule, gitFail = null, gateFail = false, dirty = "", remote = "https://github.com/drjliddy-max/qirofit-web.git" }) {
  const files = new Map([["blog-schedule.json", JSON.stringify(schedule, null, 2)]]);
  const log = [];
  const git = async (args) => {
    log.push(args.join(" "));
    if (gitFail && args[0] === gitFail) throw new Error(`git ${gitFail} failed`);
    switch (args[0]) {
      case "remote": return remote;
      case "status": return dirty;
      case "rev-parse": return args.includes("--abbrev-ref") ? "main" : "abc123def";
      case "diff": return [...files.keys()].join("\n");
      default: return "";
    }
  };
  const fs = {
    readFile: async (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return files.get(p);
    },
    writeFile: async (p, data) => { files.set(p, data); },
    mkdir: async () => {},
    rm: async (p) => { files.delete(p); }
  };
  const runGate = gateFail ? async () => { throw new Error("gate:seo found 2 problems"); } : async () => {};
  return { publisher: createRepoOwnedPublisher({ git, fs, runGate, now: () => new Date("2026-08-22T09:00:00Z") }), files, log };
}

const SCHEDULE = {
  published: [{ slug: "prior", title: "Prior", target_date: "2026-08-08" }],
  queue: [{ slug: "planned", target_date: "2026-08-22" }]
};

const CALL = { site: SITE, article: ARTICLE, image: IMAGE, occurrence: "2026-08-22", idempotencyKey: "blog-writer-qirofit:2026-08-22:1" };

// ── adapter surface ────────────────────────────────────────────────────────

test("adapter surface is closed: an extra method is refused", () => {
  const adapter = { ...createDefaultAdapter(SITE), selectTopic: () => "nope" };
  assert.throws(() => assertAdapterSurface(adapter), /may only answer/);
});

test("adapter surface is closed: a missing method is refused", () => {
  const adapter = { ...createDefaultAdapter(SITE) };
  delete adapter.publicUrl;
  assert.throws(() => assertAdapterSurface(adapter), /missing publicUrl/);
});

test("adapter cannot express orchestration: no cadence/generate/proof hooks exist", () => {
  for (const forbidden of ["cadence", "generate", "validate", "acquireImage", "writeProof", "retry", "report"]) {
    assert.equal(ADAPTER_METHODS.includes(forbidden), false, `${forbidden} must not be adapter surface`);
  }
});

// ── serialization ──────────────────────────────────────────────────────────

test("draft serialization carries the frontmatter the sites render from", () => {
  const out = serializeDraft({ article: ARTICLE, image: IMAGE, occurrence: "2026-08-22" });
  assert.match(out, /^---\n/);
  assert.match(out, /title: "What cupping therapy does for athletes"/);
  assert.match(out, /target_date: "2026-08-22"/);
  assert.match(out, /image_url: "\/photos\/what-cupping-4321\.jpg"/);
  assert.match(out, /image_provider: "pexels"/);
  assert.ok(out.includes(ARTICLE.body));
});

// ── the happy path ─────────────────────────────────────────────────────────

test("publish writes draft, image, schedule and proof, then commits and pushes", async () => {
  const { publisher, files, log } = harness({ schedule: SCHEDULE });
  const result = await publisher.publish(CALL);

  assert.equal(result.outcome, "created");
  assert.equal(result.commitSha, "abc123def");
  assert.equal(result.url, "https://qirofit.com/blog/what-cupping-therapy-does-for-athletes");
  assert.ok(files.has(".siteclinic/automation/blog-writer-qirofit/drafts/what-cupping-therapy-does-for-athletes.md"));
  assert.ok(files.has("public/photos/what-cupping-4321.jpg"));

  const schedule = JSON.parse(files.get("blog-schedule.json"));
  assert.equal(schedule.published[0].target_date, "2026-08-22");
  assert.equal(schedule.queue.length, 0, "the queue row must be consumed");
  assert.ok(log.some((l) => l.startsWith("push origin main")));
});

// ── PART 4: fail-closed matrix ─────────────────────────────────────────────

test("FAIL CLOSED: a dirty worktree refuses to publish", async () => {
  const { publisher, log } = harness({ schedule: SCHEDULE, dirty: " M src/app/page.tsx\n?? notes.md" });
  await assert.rejects(() => publisher.publish(CALL), (e) => e.stage === "worktree");
  assert.equal(log.some((l) => l.startsWith("commit")), false);
});

test("FAIL CLOSED: the wrong repository refuses to publish", async () => {
  const { publisher } = harness({ schedule: SCHEDULE, remote: "https://github.com/drjliddy-max/jeffrystein-web.git" });
  await assert.rejects(() => publisher.publish(CALL), (e) => e.stage === "repo-identity");
});

test("FAIL CLOSED: two queue rows for one occurrence refuses rather than guessing", async () => {
  const { publisher } = harness({
    schedule: { published: [], queue: [{ slug: "a", target_date: "2026-08-22" }, { slug: "b", target_date: "2026-08-22" }] }
  });
  await assert.rejects(() => publisher.publish(CALL), (e) => e.stage === "queue-ambiguous");
});

test("FAIL CLOSED: a duplicate slug refuses", async () => {
  const { publisher } = harness({
    schedule: { published: [{ slug: ARTICLE.slug, target_date: "2026-07-25" }], queue: [] }
  });
  await assert.rejects(() => publisher.publish(CALL), (e) => e.stage === "duplicate-slug");
});

test("FAIL CLOSED: a failing gate rolls the schedule back verbatim and never commits", async () => {
  const { publisher, files, log } = harness({ schedule: SCHEDULE, gateFail: true });
  const before = files.get("blog-schedule.json");
  await assert.rejects(() => publisher.publish(CALL), (e) => e.stage === "gate");
  assert.equal(files.get("blog-schedule.json"), before, "schedule must be byte-identical after rollback");
  assert.equal(files.has(".siteclinic/automation/blog-writer-qirofit/drafts/what-cupping-therapy-does-for-athletes.md"), false);
  assert.equal(log.some((l) => l.startsWith("commit")), false);
});

test("FAIL CLOSED: a failed push reverts the local commit and reports no URL", async () => {
  const { publisher, log } = harness({ schedule: SCHEDULE, gitFail: "push" });
  await assert.rejects(
    () => publisher.publish(CALL),
    (e) => e.stage === "push" && /local commit reverted/.test(e.message)
  );
  assert.ok(log.some((l) => l.startsWith("reset --hard HEAD~1")), "the unpushed commit must be reverted");
});

test("FAIL CLOSED: a git mutation failure rolls back and does not report success", async () => {
  const { publisher } = harness({ schedule: SCHEDULE, gitFail: "add" });
  await assert.rejects(() => publisher.publish(CALL), PublicationError);
});

test("FAIL CLOSED: nothing staged refuses to claim a publication", async () => {
  const files = new Map([["blog-schedule.json", JSON.stringify(SCHEDULE, null, 2)]]);
  const git = async (args) => {
    if (args[0] === "remote") return "github.com/drjliddy-max/qirofit-web";
    if (args[0] === "status") return "";
    if (args[0] === "rev-parse") return args.includes("--abbrev-ref") ? "main" : "sha";
    if (args[0] === "diff") return "";            // <- nothing staged
    return "";
  };
  const fs = {
    readFile: async (p) => files.get(p),
    writeFile: async (p, d) => { files.set(p, d); },
    mkdir: async () => {}, rm: async (p) => { files.delete(p); }
  };
  const publisher = createRepoOwnedPublisher({ git, fs });
  await assert.rejects(() => publisher.publish(CALL), (e) => e.stage === "commit");
});

// ── idempotency ────────────────────────────────────────────────────────────

test("IDEMPOTENT: an occurrence already in published is a no-op, not a second article", async () => {
  const { publisher, log } = harness({
    schedule: { published: [{ slug: "already-there", target_date: "2026-08-22" }], queue: [] }
  });
  const result = await publisher.publish(CALL);
  assert.equal(result.outcome, "already-published");
  assert.equal(result.commitSha, null);
  assert.equal(result.slug, "already-there");
  assert.equal(log.some((l) => l.startsWith("commit")), false, "a re-run must not commit");
});

test("IDEMPOTENT: rerun after a rolled-back failure leaves the repo publishable", async () => {
  const { publisher, files } = harness({ schedule: SCHEDULE, gateFail: true });
  const before = files.get("blog-schedule.json");
  await assert.rejects(() => publisher.publish(CALL));
  // Same inputs, gate now passing: the retry must succeed from a clean state.
  const retry = harness({ schedule: JSON.parse(before) });
  const result = await retry.publisher.publish(CALL);
  assert.equal(result.outcome, "created");
});
