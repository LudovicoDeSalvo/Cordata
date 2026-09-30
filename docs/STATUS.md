# Current status

Updated: 2026-09-30
Checkout: branch `slice-1` (off `planning-docs` → `main` 6695338). Milestones A and B committed on `slice-1`. `main` still holds only the initial commit; merging is the user's call.

## Current objective

Slice 1 is implemented: a durable task whose "done" is gated by Cordata running the declared verifiers on a pinned git tree snapshot, plus journal, tamper detection and `tick`. Next is **dogfooding** on the user's own repositories (D-013, D-015, D-018 metrics). Slice decisions: D-024 (attach on prompt), D-025 (tooling, cuts, fail-cap wording).

## Current state

- All seven hooks are handled: `SessionStart` (attach, UNKNOWN marking incl. own calls on `resume`, projection), `UserPromptSubmit` (NO_RESULT closing, D-024 attach + one-time projection), `Stop` gate, async `PreToolUse`/`PostToolUse`/`PostToolUseFailure` journal, async `ConfigChange` tamper check.
- Verify path: lease, (tree, specVersion) reuse, tamper check (frozen globs with basename rule, resolved scripts, (path, blob) dedup, one `~tamper` unit), large-file warning, pruning after each run.
- CLI: `install [--settings]`, `new`, `confirm`, `status`, `verify [--force]`, `tick <unit>`, `done`, `abandon`, `hook <Event>`. User-only: `confirm`, `tick`, `done`, `abandon`.
- Not built (by plan): skills (`/cordata:new`, `/cordata:status`, `/cordata:confirm`), `cordata log`, everything in ARCHITECTURE's deferred table.

## Next actions

1. User: merge `slice-1` (or keep it as a branch), then `npm install && npm link` and `cordata install` in their own terminal (writes `~/.claude/settings.json`, keeps a backup).
2. Dogfood on a real repo: `cordata new`, draft units (by hand or by asking Claude to edit the spec file), `cordata confirm`, work normally, end with `[cordata:ready]`.
3. Log per task: false blocks, unmarked completion claims (D-015 revisit trigger), gate bypasses (`cordata status`), time-to-resume, hook latency (D-014 revisit trigger at ~200 ms), tamper-unit noise.
4. After first dogfooding: write the `/cordata:new` skill (model reads package scripts/CI and drafts units; user confirms in a terminal), decide on `cordata log`.

## Blockers and questions

- None blocking. Open: license if published (user's choice).

## Validation

2026-09-30 on `slice-1`, repo root, Node 24.15.0, git 2.34.1:
- `npm run typecheck`: clean (tsc 7.0.2; verified earlier that it reports a deliberate type error and covers every project file).
- `npm test`: 38/38 pass — unit (git, spec, runner, verify incl. lease/reuse/prune, projection cap, install/guard/inert hooks, journal ordering, classifier, hooksIntact) and e2e E1–E12 plus done/abandon.
- `scripts/smoke.sh` against Claude Code 2.1.285 (`--model haiku`, all seven hooks installed): SMOKE PASS twice (after milestone A and after B) — run #1 FAIL blocked the first `[cordata:ready]` claim, haiku fixed the file, run #2 PASS, task DONE.
- Not run: `cordata install` against the real `~/.claude/settings.json` (user's step); no dogfooding yet; hook latency not measured under real use.

## Resumption notes

- Plan with schema, git sequences, gate pseudo-code and test list: `~/.claude/plans/start-planning-the-slice-smooth-sloth.md` (outside the repo; ARCHITECTURE and D-024/D-025 hold the durable parts).
- Hooks are exec form (`command` = `process.execPath`, `args` = `[<abs>/src/cli.ts, "hook", <Event>]`); Cordata entries are recognised by `args[0]` ending in `/src/cli.ts`. An nvm Node upgrade breaks them silently; `cordata status` reports missing paths.
- `CORDATA_HOME` overrides `~/.cordata`; tests use a temp `HOME`, the smoke uses `CORDATA_HOME` so Claude keeps its login.
- A `ConfigChange` of user settings without a Cordata Stop hook is flagged as tamper; if hooks were installed with `--settings` elsewhere, expect that flag on every user-settings change.
- Research briefs produced by subagents contained confident errors about hook contracts; verify host details against the raw `.md` docs (`curl https://code.claude.com/docs/en/<page>.md`).
