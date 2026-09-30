# Current status

Updated: 2026-09-30
Checkout: branch `slice-1` (off `planning-docs` → `main` 6695338). Milestone A committed on `slice-1`. `main` still holds only the initial commit; merging is the user's call.

## Current objective

Slice 1 (plan approved 2026-09-30): a durable task whose "done" is gated by Cordata running the declared verifiers on a pinned git tree snapshot, plus what dogfooding needs. Two milestones: **A** the gate end to end (done), **B** the rest. Decisions for this slice: D-024 (attach on prompt), D-025 (tooling, cuts, fail-cap wording).

## Current state

Milestone A done:
- `src/` flat layout (see `docs/TREE.md`): store, git snapshots, spec parse/validate/hash with script resolution, task new/confirm/attach, verifier runner, lease, (tree, specVersion) reuse, Stop gate (marker, FAIL cap 3 blocks, ERROR once, GATE_BYPASS on internal failure), SessionStart projection (≤ 4,000 chars, drift and branch notes), `cordata status` with restore commands and session ids.
- CLI: `install [--settings]`, `new`, `confirm` (user-only), `status`, `verify [--force]`, `hook <Event>`.
- `install` already writes all seven hooks (journal, prompt and ConfigChange ones return `{}` until milestone B), so no re-install is needed later.

## Next actions (milestone B)

1. `src/journal.ts`: `classify`, `mentionsCordata`, `recordTool` (upsert by tool_use_id; Pre never overwrites an outcome, Post always does), `closeOpen` → NO_RESULT, `markUnknown`. Wire `PreToolUse`/`PostToolUse`/`PostToolUseFailure` in `src/claude.ts` (print nothing: async stdout reaches Claude next turn).
2. `UserPromptSubmit`: close open actions as NO_RESULT; D-024 attach + one-time projection. SessionStart marks other sessions' open actions UNKNOWN; projection lists UNKNOWN actions newer than the last run.
3. Tamper (D-020, D-025): diff frozen globs (basename rule for globs without `/`) and resolved scripts against `start_tree` per run; `tamper_pair` INSERT OR IGNORE; one open `~tamper` MANUAL unit; `ConfigChange` → `hooksIntact`; Bash mentioning user-only verbs / `~/.cordata` / `cordata.sqlite` → pair.
4. `tick` (re-verifies when tree ≠ `last_pass_tree`), `done`, `abandon` (user-only, TaskEvents).
5. `prune` after each run (keep start + last PASS + last 5; closed > 30 days: drop), set `run.ref = NULL`.
6. Warnings: large untracked files (> 10 MB), sandbox enabled, other session active in the last 30 min, GATE_BYPASS count, installed hook paths missing (nvm upgrade).
7. Tests E9–E12 (see plan), re-run `scripts/smoke.sh`, then docs checkpoint and commit. Then the user runs `npm link && cordata install` and dogfoods.

## Blockers and questions

- None blocking. Open: license if published (user's choice).

## Validation

2026-09-30 on `slice-1`, repo root, Node 24.15.0, git 2.34.1:
- `npm run typecheck`: clean (tsc 7.0.2; confirmed it reports a deliberate type error and covers all 14 project files).
- `npm test`: 28/28 pass (unit: git, spec, runner, verify, projection, install/guard/inert hooks; e2e E1–E8).
- `scripts/smoke.sh` against Claude Code 2.1.285 (`--model haiku`, `--setting-sources project`): SMOKE PASS — run #1 FAIL blocked the first `[cordata:ready]` claim, haiku fixed the file, run #2 PASS, task DONE.
- Not run: `cordata install` against the real `~/.claude/settings.json` (user's step).

## Resumption notes

- Plan file with schema, git sequences, gate pseudo-code and the full test list: `~/.claude/plans/start-planning-the-slice-smooth-sloth.md` (outside the repo; ARCHITECTURE and D-024/D-025 hold the durable parts).
- Hooks are exec form (`command` = `process.execPath`, `args` = `[<abs>/src/cli.ts, "hook", <Event>]`); Cordata entries are recognised by `args[0]` ending in `/src/cli.ts`.
- `CORDATA_HOME` overrides `~/.cordata`; tests use a temp `HOME`, the smoke uses `CORDATA_HOME` so Claude keeps its login.
- Research briefs produced by subagents contained confident errors about hook contracts; verify host details against the raw `.md` docs (`curl https://code.claude.com/docs/en/<page>.md`).
