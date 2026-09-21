# Scheduled topic identity repair: 2026-09-21

Five September 10 GitHub publication attempts terminated at `queue-article-identity-mismatch`:
Site Clinic 34470486199; Book 34470839209; ADA 34470486354; Liddy 34470837747; Baby Milestone Journal 34470951257.

The resolver selected a fresh keyword without reading the occurrence's queue row. Generation derived its slug from a new headline, and the publisher correctly refused to attach the old queue metadata to that different article. The failure is upstream selection, not an overstrict publisher.

The patch uses a unique queue row's keyword/title/brief as generation input and preserves its preassigned URL slug. Multiple rows or malformed identity are refused before model work. Unqueued occurrences still use existing keyword supply. The publisher's identity check and article validators are unchanged. A model that ignores the assigned topic remains subject to the same topic-drift validation and bounded retry policy.

Regression: `src/blog-writer/__tests__/canonical.test.mjs`, test “September 10 Site Clinic queue supplies topic and stable slug before generation”, uses the actual planned slug/title/keywords/brief from that occurrence. Before: failed because it requested unrelated keyword supply. After: passes with the planned topic, fixed URL identity and SCHEDULED_QUEUE provenance. A negative test refuses ambiguous rows before generation.

Local checks: full `npm test` and `npm run typecheck` passed through the proof harness at 2026-09-21T13:03:59Z and 13:04:00Z. The initial sandbox run failed a pre-existing loopback-listener test (EPERM); rerunning with loopback permission passed. No gate was disabled.

At patch preparation, production remains unchanged: no release tag, consumer pin update, publication replay or deployment has occurred. Package v0.29.1 is the intended immutable release. Release publication, seven-consumer lockfile adoption, and scheduled recovery must each be evidenced separately. Adoption must start with Site Clinic and Book, then ADA/Liddy/BMJ, using an immutable released version and each site's required gates. Do not remove mismatch validation, rewrite the historical queue to fit an unrelated article, or count a manual replay as scheduled proof. Full run-ledger reconciliation remains blocked by unavailable current DB access in the parent Site Monitor investigation.

Release-candidate checks: full npm test passed at 2026-09-21T13:29:29Z; npm run typecheck passed at 13:29:46Z. Records are in docs/evidence/queue-identity-20260921/release-tests.json and release-typecheck.json.
