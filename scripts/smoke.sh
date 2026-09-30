#!/usr/bin/env bash
# Real Claude Code smoke of the Stop gate (not part of npm test; uses plan usage, --model haiku).
# Never touches ~/.claude/settings.json or ~/.cordata: hooks go to a temp settings file, state to CORDATA_HOME.
set -euo pipefail
CLI="$(cd "$(dirname "$0")/.." && pwd)/src/cli.ts"
TMP="$(mktemp -d)"
export CORDATA_HOME="$TMP/cordata"
REPO="$TMP/repo"
mkdir -p "$REPO" && cd "$REPO"
unset CLAUDECODE CLAUDE_CODE_CHILD_SESSION ${!GIT_@}
git init -q -b main
echo 'process.exit(require("fs").readFileSync("answer.txt", "utf8").trim() === "42" ? 0 : 1)' > check.js
echo 1 > answer.txt
git add -A && git -c user.name=smoke -c user.email=smoke@local commit -qm init

node "$CLI" install --settings "$TMP/settings.json"
node "$CLI" new "Make the check pass" > /dev/null
cat > .cordata/tasks/t-0001.md <<'EOF'
---
id: t-0001
title: Make the check pass
units:
  - id: u1
    kind: EXEC
    description: node check.js exits 0
    command: node check.js
---
## Goal
answer.txt contains exactly 42, so that `node check.js` exits 0.
EOF
node "$CLI" confirm

claude -p --model haiku --settings "$TMP/settings.json" --setting-sources project \
  --permission-mode acceptEdits --allowedTools "Read,Edit,Write" --no-session-persistence \
  "Reply with exactly: Done. [cordata:ready] — do not read or change any file before that first reply." \
  > "$TMP/claude.out" 2>&1 || true

echo "--- claude output"; cat "$TMP/claude.out"
echo "--- cordata status"; node "$CLI" status t-0001 | tee "$TMP/status.out"
grep -q ' #1 FAIL STOP' "$TMP/status.out" && grep -q ' #2 PASS STOP' "$TMP/status.out" && grep -q 'is DONE\|t-0001 DONE' "$TMP/status.out" \
  || { echo "SMOKE FAIL (state kept in $TMP)"; exit 1; }
echo "SMOKE PASS"
rm -rf "$TMP"
