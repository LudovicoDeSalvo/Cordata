# Red-team review of the v1 plan (2026-09-29)

Scope: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` D-001 … D-013, `docs/STATUS.md` slice 1. Nothing is implemented, so every finding is about the plan.

Method: raw Claude Code docs fetched with curl from `https://code.claude.com/docs/en/{hooks,sandboxing,permission-modes,env-vars,tools-reference,interactive-mode,goal}.md` on 2026-09-29; local experiments on this machine. Installed: Claude Code 2.1.284, Node 24.15.0, git 2.34.1, curl 8.16.0. `bwrap` is **not installed**. Items marked [U] are unverified.

Outcome (user-confirmed 2026-09-29): F1–F3 → D-015; F5 → D-016; F12 + slice cuts → D-017; no-daemon finding → D-014 (also closes F7, F18); F10 applied in `docs/ARCHITECTURE.md`; F4, F8, F9, F21 → D-018; F6 → D-019; F11 + F19b → D-020; F15, F16 → D-021; F13, F14, F20 → D-022; F17 + F19a → D-023. No finding remains open.

## Critical: the plan does not work as written

**F1. `stop_hook_active` is misread; the gate would block at most once per turn.** The plan allows Stop whenever `stop_hook_active` is true, believing it turns true after 7 blocks. Docs: it is `true` "when Claude Code is already continuing as a result of a stop hook", i.e. on the Stop right after the first block. Failing fix attempt 1 is then let through. The host cap is 8 consecutive continuations (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). Fix: never short-circuit on it. Use it only to reset Cordata's own consecutive-fail counter (`false` = new chain). Keep the cap-3 rule on Cordata's own counter.

**F2. Stop fires after every turn, so the gate runs on turns that do not claim completion.** Docs: Stop is a per-turn event. As planned, every turn end in an attached worktree runs all EXEC units and blocks on FAIL. That includes a clarifying question, a TDD "tests written, now failing" step, a progress report, or an unrelated Q&A turn. Claude is pushed to keep coding without the user's answer, and each turn waits for the verifier runtime. Fix (amends D-008): verify only when all of these hold. (a) The tree changed since Cordata's last run for this task. (b) `background_tasks` is empty (Stop input field; the session is paused, not done). (c) The turn claims completion, via a marker in `last_assistant_message` (Stop input field) that the projection documents. Otherwise allow without running anything. `cordata verify` stays available on demand. Open design choice: marker only, or marker plus a completion-phrase heuristic.

**F3. The Stop block JSON shape in the contracts brief is wrong.** Docs: `{"decision":"block","reason":"..."}` goes at top level, not inside `hookSpecificOutput`. A wrong shape fails schema validation, which is a non-blocking error, so the gate is silently open. (`hookSpecificOutput.additionalContext` on Stop also continues the turn, labelled as feedback instead of an error.)

**F4. Every failure mode is fail-open and silent.** A timed-out hook's output is discarded, so no decision is made; the default `command` timeout is 600 s. Exit codes other than 2 are non-blocking, and so are an unreachable socket or bad JSON. A long suite, a crashed daemon or a typo in the settings path all disable the gate without notice. Fix: set an explicit `timeout` on the Stop hook, and give the daemon a total budget below it so that it always returns a decision itself. The shim always exits 0 and appends each bypass to `~/.cordata/bypass.log`. The next projection reports "gate bypassed at …".

**F5. The model can perform every "user-only" action.** `cordata confirm|tick|done|abandon` are reachable through the model's Bash tool, through curl to the socket, or through `sqlite3` on the DB, since the sandbox is off and runs as the same uid. The planned `/cordata:confirm` skill even has the model run `confirm`. D-008's "confirmed once by the user" therefore reduces to "the model confirmed". Fix:
- The CLI refuses user-only verbs when `CLAUDE_CODE_CHILD_SESSION=1`, which Claude Code sets in Bash and hook subprocesses (env-vars doc). The skills end with "ask the user to run `cordata confirm` in their terminal".
- The daemon flags any journaled Bash command that mentions the user verbs, the socket or the DB path as a tamper MANUAL unit.
- Record the threat model: tamper-evident against a drifting, reward-hacking model; not tamper-proof against a deliberate adversary with the same uid.
- [U] whether Claude Code's `!` shell mode sets that variable.

## High

**F6. Daemon-run verifiers sidestep the Claude sandbox and the permission prompt.** At each gate the model's own test code runs unsandboxed with the user's full environment. In `default` permission mode, the user's approval of `npm test` is also skipped. There is no escalation today (bwrap is missing, so there is no sandbox), but D-012 recommends enabling it. Fix: document this now. When the sandbox is enabled, wrap verifiers with `@anthropic-ai/sandbox-runtime`, the same primitives packaged standalone (sandboxing doc) [U: its CLI and settings flags].

**F7. Verifier environment drift.** The daemon inherits the environment of whichever hook spawned it first. PATH, nvm/conda or venv changes in later sessions are not seen, which produces false FAIL or PASS. This machine uses anaconda. Fix: take the environment from the Stop request and never persist it. For example, the shim sends `$$` and the daemon reads `/proc/<pid>/environ` (Linux-only, which D-002 allows); the minimum is a PATH header.

**F8. The PASS→tree binding overclaims.** Verifiers run in the live worktree, not on the snapshot. Ignored files (node_modules, .env, build output) are outside the tree. Background tasks, a second session, or a `--fix` / snapshot-update verifier can change files mid-run. Fix: run `write-tree` before and after, and record ERROR "worktree changed during verification" on a mismatch; honour (b) of F2. Reword invariant 2 as "PASS observed on a worktree whose non-ignored content was tree X".

**F9. Several sessions on one task.** Each Stop is gated independently, so verifier runs can overlap in one worktree, and session B's work in progress blocks session A. Fix: a per-worktree mutex, plus a result cache keyed by (treeHash, specVersion). The cache also removes repeated runs on an unchanged tree.

**F10. Restore as described writes the user's index.** Verified locally: `git checkout <tree> -- .` staged the changes, which violates invariant 6. `git restore --source=<tree> --worktree -- .` leaves the index untouched. It deletes tracked files that are absent from the tree and leaves untracked files in place (also verified). Alternatively, cut `restore` from slice 1 and print that command instead.

**F11. Tamper-detection gaps.**
- (a) Script indirection: `npm test` → edit `package.json` so the script is `exit 0`. `package.json` is not in the default globs.
- (b) The "lint/type config" list is unspecified.
- (c) The file watcher picks up `.claude/settings*.json` edits live, so the model can remove the hooks or set `disableAllHooks`. The Edit tool prompts for these protected paths, but auto mode routes them to the classifier, and a Bash write is unguarded without the sandbox.
- (d) The model can narrow the globs by editing `.cordata/config.json`.
- (e) Ignored files are invisible to a tree diff; `settings.local.json` is gitignored.

Fix: store the resolved script text for `npm test` / `npm run X` at confirm and compare it at each run. Freeze the tamper globs and config into the confirmed version. Add a `ConfigChange` hook that records, or blocks with exit 2, changes that drop Cordata's hooks. Ship an explicit default glob list.

**F12. Orphaned journal entries are mostly not crashes.** `PreToolUse` fires before the permission check. A denied dialog fires nothing afterwards; `PermissionDenied` fires only in auto mode. A failed tool fires `PostToolUseFailure`, not `PostToolUse`. An interrupt fires no Stop. The "outcome unknown" list would fill with denials and interrupts. Fix:
- Handle `PostToolUseFailure`.
- Close a session's open actions as NO_RESULT at its next Stop or `UserPromptSubmit`; only actions still open when a session dies are UNKNOWN.
- Journal only `Bash|Edit|Write|NotebookEdit|mcp__.*` via the hook matcher. READ-class calls carry no value and dominate hook traffic.

## Medium

- **F13 Project id.** "Canonical root + remote fingerprint" gives each worktree a different id and changes when a remote is added or renamed. Fix: key on the realpath of `git rev-parse --git-common-dir`.
- **F14 Init writes tracked files.** Adding `.cordata/` to `.gitignore` edits the user's repo. Fix: write to `.git/info/exclude`, which is shared by worktrees, and put the hooks in `.claude/settings.local.json`.
- **F15 Spec hash over the whole file.** Edits to Notes or Goal reset every unit and force a re-confirm. Fix: specVersion = hash of the normalized units plus the frozen config.
- **F16 Stale PASS.** More edits after VERIFIED_PENDING_MANUAL, followed by `tick`, give DONE on an unverified tree. Fix: DONE requires current tree == last PASS tree; otherwise the task returns to ACTIVE.
- **F17 Projection limits.** `additionalContext` over 10,000 chars is moved to a file with a 2,000-char preview. The docs warn that imperative "system command" phrasing can trip prompt-injection defenses. Fix: cap the projection at about 4k chars in factual phrasing. Handle SessionStart `clear` and `fork` too.
- **F18 Shim start race.** Parallel tool calls run concurrent shims, which can spawn several daemons; unlinking a stale socket is racy; "retry once" is too short for a Node cold start. Fix: `flock` around the spawn and poll for up to about 2 s. Exit 0 always and let the JSON decide.
- **F19 Work moves out of the worktree.** After `EnterWorktree` or a cwd move to another worktree, the gate verifies the original, unchanged tree and passes stale code. Fix: skip the gate with a note when the Stop `cwd` resolves to another worktree. Flag in the projection when HEAD ≠ `branchAtCreation`.
- **F20 Snapshot growth.** Refs pin every run forever, and large untracked, non-ignored files are hashed into `.git/objects` on every run. Fix: retention (last PASS plus the last N runs per task). Seed the temp index from a copy of the real index; verified to work, and it avoids a full rehash. Warn on large files.
- **F21 ERROR loops.** A verdict of "command not found", timeout or missing env makes the model flail on infrastructure it cannot fix. Fix: block on FAIL; an ERROR blocks once, then passes with a note.

## Simplifications (cut from slice 1)

- `PreCompact` hook: no use; `SessionStart(compact)` already re-injects.
- Verifier registry scan (D-011): the model reads `package.json` and CI itself when drafting. Defer until drafting quality proves weak.
- `UserPromptSubmit`: keep it only for closing orphans (F12).
- The `yaml` dependency is justified; frontmatter parsing is not a few lines.

## Resolved open items

- `node:sqlite` works on the installed Node 24.15.0 (SQLite 3.51.3) with no warning printed. Pick it; no native dependency.
- The Stop contract is confirmed empirically on Claude Code 2.1.284 (`claude -p --model haiku --settings` with a logging Stop hook, 2026-09-29): top-level `{"decision":"block","reason"}` continues the turn; `stop_hook_active` was `false` on the 1st Stop and `true` on the 2nd and 3rd (F1, F3). `last_assistant_message` and `background_tasks: []` are present.
- A tree-object ref under `refs/cordata/*` is tolerated by `git log --all`, `rev-list --all`, `gc` and `fsck` on git 2.34.1.

## Structural finding: v1 may not need a daemon

D-006 and D-013 justify the daemon by the latency of a hook on every tool call. Measured on this machine: a Node 24 cold start plus opening `node:sqlite` plus a WAL insert takes 20–40 ms. In v1 the journal hooks never return a decision, so they can run with `async: true` and add no latency at all. SQLite in WAL mode with a `busy_timeout` serializes concurrent writers.

A per-event `cordata hook <event>` Node process would remove several findings:
- F7: the Stop hook process inherits the session's environment and runs the verifiers itself.
- F18: no socket, no spawn race, no idle timeout.
- F5 and F4, in part: the socket-forgery route and the daemon-down case disappear.

The cost is that invariant 8 changes from "one process writes" to "one code path writes PASS/FAIL". Proposed: build slice 1 without a daemon, and add one only if measured hook latency or write contention demands it (amends D-006, D-013).

## Prior art

Source: a subagent's web search on 2026-09-29; not re-verified here.

The narrow claim holds: no tool found combines a durable task, acceptance units, tool-run verification on a snapshot and tamper review. A Stop gate that runs tests, though, is commodity:
- **loop-hooks** (github.com/wwwcojp/loop-hooks, 0★). The Stop hook runs a verify command only when a git fingerprint changes. It reads its config from HEAD so the agent cannot disable it, and turns a repeated failure on the same fingerprint into a warning. This is the same shape as F2a/F9, and config-from-HEAD is an alternative to freezing the config at confirm (F11d).
- **proof-of-done** (github.com/wasaybuilds/proof-of-done, 1★). SessionStart records a base commit. The Stop hook uses git plus AST analysis, with no LLM, to detect deleted or skipped tests and weakened or vacuous assertions; it is capped at 3 blocks. This is the best prior art for tamper detection and is stronger than a glob diff.
- **Canon** (github.com/urban233/Canon). The Stop gate runs a verify command, treats a timeout as a failure, and is capped at 3.
- Most other gates trust the transcript or the model's self-check: done-needs-proof, verify-gate, jev-belay, the ralph-loop promise string, and TDD Guard (PreToolUse plus a model call).
- Durable task and spec tools run no acceptance checks themselves: Task Master (`testStrategy` is plain text), spec-kit, ccpm, Backlog.md (checkboxes the agent ticks), cc-sessions, beads and vibe-kanban.
- Native options: `/goal` is a prompt Stop hook that Haiku evaluates without running commands. Task tools with `TaskCompleted` can gate completion, but they have no acceptance field and are off by default on Opus 5.x.

Reported pitfalls match F2 and F4:
- gates firing on every chat turn, adding 2–7 s each time
- clarifying questions getting blocked
- loops with background agents
- `stop_hook_active` not being set when reminders interleave (issue #54360, reported)

Common conventions are fail-open behavior, a cap of 1–3 blocks, and change-gating by tree fingerprint.

Implication: the value lies in the combination, not in the gate: a user-confirmed spec with units, durable across sessions, verified by the tool on a pinned tree, with tamper review. Dogfood the gate early to learn whether the rest earns its cost.
