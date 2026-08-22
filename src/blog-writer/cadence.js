/**
 * Publication cadence, derived from the governing contract, not restated.
 *
 * Mirror of `site-monitor/contracts/publication-cadence.json` (contractId
 * `publication-14d-v1`) and `site-monitor/src/lib/blogCadence.ts`. This file is
 * byte-identical in every publisher repo; verify with sha256 before trusting a
 * lane's copy.
 *
 * WHY THIS EXISTS
 *
 * Every lane previously enumerated its own eligible dates with a hardcoded
 * `SCHEDULER_WEEKDAYS = new Set([2, 4])`, the superseded `tuesday_thursday`
 * contract. When the estate migrated to `publication-14d-v1`, whose activation
 * date 2026-08-08 is a SATURDAY, every lane's readiness checker went blind to
 * its own governed occurrence: the date was never enumerated, so the slot was
 * never evaluated. All seven lanes published on 2026-08-08 and no lane's
 * readiness report could see it.
 *
 * The interval is therefore derived from the contract anchor, never from a
 * weekday set and never from `now`.
 *
 * ANCHOR SOURCE AND ITS LIMIT
 *
 * The authoritative anchor is the verified `job_runs` row in Site Monitor
 * (`anchorPredicate` in the contract). A site-local `.mjs` cannot reach that
 * database. This module therefore derives the anchor from the lane's own
 * publication series in `blog-schedule.json`, which the contract defines as the
 * same quantity observed locally (`publicationDateFrom: "scheduled_for"`, i.e.
 * `target_date`). That is sound for readiness reporting and unsound as a
 * publication authority: readiness reports, it does not dispatch.
 *
 * This limit is the reason the repair is bounded: correct cadence ownership
 * requires the shared pipeline, not seven copies of this file.
 */

/** Portfolio publication interval, in days. Mirrors the contract. */
export const PUBLICATION_INTERVAL_DAYS = 14;

/** Identity of the active publication cadence contract. */
export const CADENCE_CONTRACT_ID = "publication-14d-v1";

/** Contract this one supersedes. Retained so legacy history stays explicable. */
export const SUPERSEDED_CADENCE_CONTRACT_ID = "tuesday_thursday";

/**
 * The ONLY date on which a cohort lane may establish its first
 * publication-14d-v1 anchor. Mirrors `migration.activationDate`.
 */
export const CADENCE_MIGRATION_ACTIVATION_DATE = "2026-08-13";

const MS_PER_DAY = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parse at UTC noon so no DST shift can move the calendar day. */
function parseDay(date) {
  if (typeof date !== "string" || !DATE_ONLY.test(date)) {
    throw new Error(`Invalid cadence date: ${JSON.stringify(date)}`);
  }
  const parsed = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid cadence date: ${date}`);
  }
  return parsed;
}

function formatDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date, days) {
  return formatDay(parseDay(date) + days * MS_PER_DAY);
}

export function daysBetween(from, to) {
  return Math.round((parseDay(to) - parseDay(from)) / MS_PER_DAY);
}

/**
 * The lane's cadence anchor: the most recent publication target date, unless the
 * schedule carries an explicit `schedule.cadence_anchor` re-basing.
 *
 * Returns null when the lane has never published and declares no explicit anchor.
 * A lane with no anchor has no computable slot lattice (inventing one from `now`
 * is the drift the contract forbids), so callers must handle null rather than
 * substitute today.
 *
 * EXPLICIT ANCHOR (added for FND-0008 / RMD-0007, operator option (a)): the
 * original anchor derived from history (2026-08-08, a Saturday) produced a
 * lattice the Tue/Thu dispatcher could never reach. `schedule.cadence_anchor`
 * lets governance re-base the lattice explicitly, as reviewed DATA in the
 * consumer repo. Two fail-closed rules:
 *   - invalid format throws (a silently ignored governance field is worse than
 *     a crash);
 *   - a backdated explicit anchor (earlier than real publication history) is
 *     refused: re-basing may only move the lattice FORWARD, so an explicit
 *     anchor can never mask or rewrite what actually published.
 */
export function resolveCadenceAnchor(schedule) {
  const published = Array.isArray(schedule?.published) ? schedule.published : [];
  const dates = published
    .map((entry) => entry?.target_date)
    .filter((value) => typeof value === "string" && DATE_ONLY.test(value));
  const derived = dates.length === 0
    ? null
    : dates.reduce((latest, current) => (current > latest ? current : latest));

  const explicit = schedule?.schedule?.cadence_anchor;
  if (explicit === undefined || explicit === null) {
    return derived;
  }
  if (typeof explicit !== "string" || !DATE_ONLY.test(explicit)) {
    throw new Error(`Invalid cadence_anchor: ${JSON.stringify(explicit)} (expected YYYY-MM-DD)`);
  }
  if (derived !== null && explicit < derived) {
    // STEADY STATE after the first canonical publication: the schedule keeps
    // `cadence_anchor` (e.g. 2026-08-13) while published target_dates advance
    // by 14n (2026-08-27, 09-10, …). That is the SAME clock, not a re-base, and
    // must be accepted - before this rule, the second canonical occurrence
    // would have thrown here. Only an earlier anchor OFF the history's lattice
    // rewrites history and is refused.
    if (daysBetween(explicit, derived) % PUBLICATION_INTERVAL_DAYS === 0) {
      return explicit;
    }
    throw new Error(
      `cadence_anchor ${explicit} is earlier than the latest real publication ${derived} and not on its lattice; ` +
      "re-basing may only move the lattice forward, never rewrite history.",
    );
  }
  return explicit;
}

/**
 * Is this date on the governed lattice (anchor + 14n, n an integer)?
 *
 * Dates before the anchor are on the lattice when they are an exact multiple of
 * the interval away from it; that keeps legacy pre-migration history from being
 * reported as a cadence violation purely because it predates the anchor.
 */
export function isGovernedTargetDate(anchor, targetDate) {
  if (!anchor) {
    return false;
  }
  return daysBetween(anchor, targetDate) % PUBLICATION_INTERVAL_DAYS === 0;
}

/**
 * The governed slot lattice at or after `fromDate`.
 *
 * Slots are computed from the anchor by multiplication rather than by repeated
 * addition, so no rounding error can accumulate across a long runway.
 */
export function buildScheduledDates(anchor, fromDate, slots) {
  const count = Number(slots);
  if (!anchor || !Number.isFinite(count) || count <= 0) {
    return [];
  }
  const offset = daysBetween(anchor, fromDate);
  // Index of the first lattice slot at or after fromDate.
  const firstIndex = Math.ceil(offset / PUBLICATION_INTERVAL_DAYS);
  return Array.from({ length: count }, (_, index) =>
    addDays(anchor, PUBLICATION_INTERVAL_DAYS * (firstIndex + index)),
  );
}

/** Human-readable cadence description for the readiness report. */
export function cadenceLabel(anchor) {
  if (!anchor) {
    return `${CADENCE_CONTRACT_ID}: every ${PUBLICATION_INTERVAL_DAYS} days, no anchor established yet`;
  }
  return `${CADENCE_CONTRACT_ID}: every ${PUBLICATION_INTERVAL_DAYS} days, anchored on ${anchor}`;
}
