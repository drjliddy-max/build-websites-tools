#!/bin/bash
# Reproducible mutation campaign for gate-snapshot.
#
# Each mutation is applied to real source, a TARGETED test is run, and the run
# must FAIL. A patch that does not apply is a hard error - otherwise a
# non-applying patch reads as "caught" and the campaign lies.
#
# Restoration is verified by SHA-256 against the pre-campaign state, so the
# campaign cannot leave the tree subtly modified.
#
# Usage:  bash scripts/mutation-campaign.sh
set -uo pipefail
cd "$(dirname "$0")/.."

FILES="src/snapshot.ts src/gate-snapshot.ts src/snapshot-validate.ts package.json"
BASELINE=$(shasum -a 256 $FILES | shasum -a 256 | cut -d' ' -f1)

PASS=0; FAIL=0
declare -a RESULTS

restore() { git checkout -- $FILES 2>/dev/null; }

apply() { # apply <id> <python-heredoc-body-file>
  if ! python3 "$1" 2>/tmp/mut.err; then
    echo "PATCH FAILED TO APPLY: $(cat /tmp/mut.err)"; return 1
  fi
  return 0
}

run_mutation() {
  local id="$1" desc="$2" filter="$3"
  local out rc
  out=$(node --import tsx --test --test-name-pattern="$filter" src/__tests__/*.test.ts 2>&1)
  rc=$?
  local restored
  restore
  restored=$(shasum -a 256 $FILES | shasum -a 256 | cut -d' ' -f1)
  if [ "$restored" != "$BASELINE" ]; then
    RESULTS+=("RESTORE-FAIL | $id | $desc | tree not byte-identical after restore")
    FAIL=$((FAIL+1)); return
  fi
  if [ $rc -ne 0 ]; then
    local failing
    failing=$(echo "$out" | grep -m2 "^not ok" | sed 's/^not ok [0-9]* - //' | tr '\n' ';')
    RESULTS+=("CAUGHT   | $id | $desc | ${failing:-<none>} | restore=${restored:0:12}")
    PASS=$((PASS+1))
  else
    RESULTS+=("ESCAPED! | $id | $desc | NO TEST FAILED")
    FAIL=$((FAIL+1))
  fi
}

mutate() { # mutate <id> <desc> <filter> <<'EOF' python EOF
  local id="$1" desc="$2" filter="$3"
  cat > /tmp/mut.py
  if ! python3 /tmp/mut.py 2>/tmp/mut.err; then
    RESULTS+=("PATCH-FAIL | $id | $desc | $(head -1 /tmp/mut.err)")
    FAIL=$((FAIL+1)); restore; return
  fi
  run_mutation "$id" "$desc" "$filter"
}

S=src/snapshot.ts; G=src/gate-snapshot.ts; V=src/snapshot-validate.ts

mutate M01 "absent authorization permits write" "authorization inert" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='  if (raw === "1") return { armed: true };'
assert o in s, 'no anchor'
open(p,'w').write(s.replace(o,o+'\n  return { armed: true };',1))
EOF

mutate M02 "arbitrary nonempty authorization value arms" "authorization inert" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='  if (raw === "1") return { armed: true };'
assert o in s
open(p,'w').write(s.replace(o,'  if (raw !== undefined && raw !== "") return { armed: true };',1))
EOF

mutate M03 "deprecated destination variable accepted" "deprecated GATE_SNAPSHOT_DIR" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='  if (Object.prototype.hasOwnProperty.call(env, DEPRECATED_DIR_ENV)) {'
assert o in s
open(p,'w').write(s.replace(o,'  if (false) {',1))
EOF

mutate M04 "destination becomes caller-controlled" "M3 gap" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='  const artifactRoot = path.join(repoRoot, ...ARTIFACT_DIR_SEGMENTS);'
assert o in s
open(p,'w').write(s.replace(o,'  const artifactRoot = process.env.GATE_SNAPSHOT_DIR ?? path.join(repoRoot, ...ARTIFACT_DIR_SEGMENTS);',1))
EOF

mutate M05 "confinement check removed" "isInside|rejects absolute and traversal" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='export function isInside(root: string, target: string): boolean {'
assert o in s
open(p,'w').write(s.replace(o,o+'\n  return true;',1))
EOF

mutate M06 "symlink swap accepted" "symlink|replaced between resolution" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='        return { ok: false, reason: "destination is a symlink; refusing to write" };'
assert o in s
s=s.replace(o,'        /* mutated */',1)
o2='        return { ok: false, reason: "artifact directory is a symlink; refusing to write" };'
s=s.replace(o2,'        /* mutated */',1)
open(p,'w').write(s)
EOF

mutate M07 "zero evidence becomes complete" "can NEVER be complete|reason is null if and only if" <<'EOF'
p='src/gate-snapshot.ts';s=open(p).read()
o='  if (input.expectedGates.length === 0) {'
assert o in s
s=s.replace(o,'  if (false) {',1)
s=s.replace('  if (input.merge.gatesRun.length === 0) {','  if (false) {',1)
open(p,'w').write(s)
EOF

mutate M08 "missing expected gate omitted" "missing expected gate produces not_run" <<'EOF'
p='src/gate-snapshot.ts';s=open(p).read()
o='''    if (!frag) {
      gates[gate] = {
        outcome: "not_run",'''
assert o in s
open(p,'w').write(s.replace(o,'''    if (!frag) {
      continue;
    }
    if (false) {
      gates[gate] = {
        outcome: "not_run",''',1))
EOF

mutate M09 "invalid outcome accepted" "fragment validation rejects: invalid outcome" <<'EOF'
p='src/snapshot-validate.ts';s=open(p).read()
o='''  if (typeof outcome !== "string" || !FRAGMENT_OUTCOMES.has(outcome)) {'''
assert o in s
open(p,'w').write(s.replace(o,'  if (false) {',1))
EOF

mutate M10 "missing fragment version accepted" "fragment version rejected: missing" <<'EOF'
p='src/snapshot-validate.ts';s=open(p).read()
i=s.index('  if (!hasOwn(input, "fragmentSchemaVersion")) {')
j=s.index('  const gate = ownGet(input, "gate");')
open(p,'w').write(s[:i]+s[j:])
EOF

mutate M11 "future fragment version accepted" "fragment version rejected: 2" <<'EOF'
p='src/snapshot-validate.ts';s=open(p).read()
o='    } else if (v !== REQUIRED_FRAGMENT_SCHEMA_VERSION) {'
assert o in s
open(p,'w').write(s.replace(o,'    } else if (false) {',1))
EOF

mutate M12 "prototype-chain key bypasses validation" "prototype-shaped keys cannot pose" <<'EOF'
p='src/snapshot-validate.ts';s=open(p).read()
o='      if (props !== undefined && hasOwn(props, k)) {'
assert o in s
open(p,'w').write(s.replace(o,'      if (props !== undefined && (props as any)[k]) {',1))
EOF

mutate M13 "unsupported schema keyword ignored" "unsupported keyword fails closed" <<'EOF'
p='src/snapshot-validate.ts';s=open(p).read()
o='      if (!IMPLEMENTED_KEYWORDS.has(key)) {'
assert o in s
open(p,'w').write(s.replace(o,'      if (false) {',1))
EOF

mutate M14 "skipped gate becomes pass" "M14 gap" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='''    const outcome: FragmentOutcome = skipped
      ? "skipped"'''
assert o in s
open(p,'w').write(s.replace(o,'''    const outcome: FragmentOutcome = false
      ? "skipped"''',1))
EOF

mutate M15 "skipped gate permits complete" "skipped gate blocks complete|skip among passing" <<'EOF'
p='src/gate-snapshot.ts';s=open(p).read()
o='  if (input.merge.skipped.length > 0) {'
assert o in s
open(p,'w').write(s.replace(o,'  if (false) {',1))
EOF

mutate M16 "final semantic validation bypassed" "M16 gap" <<'EOF'
p='src/gate-snapshot.ts';s=open(p).read()
o='  return validateSnapshotSemantics(snapshot);'
assert o in s
open(p,'w').write(s.replace(o,'  return { valid: true };',1))
EOF

mutate M17 "summary inconsistency accepted" "summary counts must match" <<'EOF'
p='src/snapshot-validate.ts';s=open(p).read()
o='    if (ownGet(summary, "checksTotal") !== total) {'
assert o in s
open(p,'w').write(s.replace(o,'    if (false) {',1))
EOF

mutate M18 "direct non-atomic write restored" "no temporary residue|leave no temporary" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='    renameSync(tmp, finalTarget);'
assert o in s
open(p,'w').write(s.replace(o,'    require("node:fs").writeFileSync(finalTarget, contents, "utf8");',1))
EOF

mutate M19 "exclusive temp creation removed" "M19 gap" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='  return openSync(file, "wx", 0o600);'
assert o in s
open(p,'w').write(s.replace(o,'  return openSync(file, "w", 0o600);',1))
EOF

mutate M20 "flush error swallowed" "M20 gap" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='    flushFile(fd);'
assert o in s
open(p,'w').write(s.replace(o,'    try { flushFile(fd); } catch {}',1))
EOF

mutate M21 "temp cleanup removed" "failed write leaves no temporary residue|rename failure cleans up" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='''      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* best-effort */
      }'''
assert o in s
open(p,'w').write(s.replace(o,'      /* mutated */',1))
EOF

mutate M22 "concurrent merge lock removed" "merge lock is exclusive" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='  let fd = attempt();'
assert o in s
open(p,'w').write(s.replace(o,'  let fd: number | null = 1; try { unlinkSync(lockPath); } catch {} fd = attempt() ?? 1;',1))
EOF

mutate M23 "schema omitted from tarball" "every required public entry ships" <<'EOF'
import json,collections
p='package.json';d=json.load(open(p),object_pairs_hook=collections.OrderedDict)
d['files']=[f for f in d['files'] if f!='schema']
json.dump(d,open(p,'w'),indent=2);open(p,'a').write("\n")
EOF

mutate M24 "tests or fixtures enter tarball" "no tests, fixtures, or internal documents" <<'EOF'
import json,collections
p='package.json';d=json.load(open(p),object_pairs_hook=collections.OrderedDict)
d['files']=[f for f in d['files'] if f!='!src/__tests__']
json.dump(d,open(p,'w'),indent=2);open(p,'a').write("\n")
EOF

mutate M25 "installed package resolves source-tree schema" "modules resolve ONLY inside" <<'EOF'
import json,collections
p='package.json';d=json.load(open(p),object_pairs_hook=collections.OrderedDict)
d['files']=[f for f in d['files'] if f!='schema']
json.dump(d,open(p,'w'),indent=2);open(p,'a').write("\n")
EOF

mutate M26 "fatal armed failure exits zero" "exits NONZERO|deprecated GATE_SNAPSHOT_DIR" <<'EOF'
p='src/gate-snapshot.ts';s=open(p).read()
o='      return { code: 1, stderr }; // asked for incorrectly -> fail closed, loudly'
assert o in s
open(p,'w').write(s.replace(o,'      return { code: 0, stderr };',1))
EOF

mutate M27 "path-with-space module guard fails" "M27 gap" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='    const pkg = require("../package.json") as { version?: string };'
assert o in s
open(p,'w').write(s.replace(o,'    const pkg = require(new URL("../package.json", import.meta.url).pathname) as { version?: string };',1))
EOF

mutate M28 "git timeout becomes inert success" "non-git working directory" <<'EOF'
p='src/snapshot.ts';s=open(p).read()
o='''    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}'''
assert o in s
open(p,'w').write(s.replace(o,'''    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return "/tmp";
  }
}''',1))
EOF

restore
FINAL=$(shasum -a 256 $FILES | shasum -a 256 | cut -d' ' -f1)
echo
echo "======================= MUTATION MATRIX ======================="
printf '%s\n' "${RESULTS[@]}"
echo "==============================================================="
echo "caught: $PASS   escaped/failed: $FAIL   of $((PASS+FAIL))"
echo "baseline sha256: $BASELINE"
echo "final    sha256: $FINAL"
[ "$BASELINE" = "$FINAL" ] && echo "RESTORATION: byte-exact" || echo "RESTORATION: MISMATCH"
echo -n "worktree dirty files: "; git status --short | wc -l | tr -d ' '
