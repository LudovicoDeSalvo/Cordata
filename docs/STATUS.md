# Current status

Updated: 2026-09-30
Checkout: planning docs committed on branch `planning-docs` (off `main` 6695338). No code.

## Current objective

Red-team the plan and resolve every finding before implementation. **Done 2026-09-29.** Findings in `docs/research/2026-09-29-plan-redteam.md`; all 21 resolved with the user as D-014 … D-023 (grill-style interview for D-018 … D-023). `docs/ARCHITECTURE.md`, README, AGENTS, TREE match the decisions.

## Current state

- Plan: D-001 … D-023 accepted; no open red-team finding.
- No implementation, no tests, no package.json.

## Next actions

1. Implementation slice 1:
   1. `package.json` (TypeScript strict, vitest, `node:sqlite`; `yaml` for frontmatter).
   2. `store/sqlite.ts` (WAL, busy timeout, run lease) for the records in `docs/ARCHITECTURE.md`; `core/spec.ts` parse/validate, script resolution, specVersion hash (D-021).
   3. `core/snapshot.ts`: project id from git common dir (D-022), temp index seeded from a copy of the real index, `write-tree`, `refs/cordata/<task>/<run>`, retention pruning, restore via `git restore --source --worktree`. Unit test on a fixture repo.
   4. `core/verify.ts`: EXEC units with timeouts and budget, before/after tree check, FAIL vs ERROR, tamper (globs, scripts, (path, blob) dedup), (tree, specVersion) reuse (D-018, D-020).
   5. `cli.ts hook <event>` + `adapters/claude.ts`: `SessionStart` (5 sources, 4k projection), `UserPromptSubmit`, `Stop` gate (D-015, D-018), async journal hooks (D-017), `ConfigChange` (D-020). Fail-open with `GATE_BYPASS`.
   6. CLI: `install`, `new`, `confirm`, `status`, `verify`, `tick` (re-verifies, D-021), `restore`; user-only guard (D-016).
   7. Fixture e2e by piping hook JSON: marked claim with failing test blocks → fix → claim passes; unmarked Stop passes without running; ERROR blocks once; session dies mid-tool → next SessionStart lists UNKNOWN action.
   8. One real smoke through Claude Code (headless, `--model haiku`) of the Stop gate.
2. Dogfood; log false blocks, unmarked completion claims, gate bypasses, and time-to-resume (D-013, D-015, D-018).

## Blockers and questions

- None blocking slice 1.
- Open: license if published (user's choice).

## Validation

No code. Checked 2026-09-30: `CLAUDE_CODE_CHILD_SESSION=1` in both the model's Bash tool and the user's `!` shell mode (D-016: user-only verbs need a separate terminal). `@anthropic-ai/sandbox-runtime` 0.0.78 on npm ships CLI `srt` (`srt [--settings file] <cmd>`, config `~/.srt-settings.json`, uses bubblewrap on Linux) — read from the npm readme, not executed; D-019's revisit also needs `bwrap` installed. Checked 2026-09-29: raw docs from code.claude.com (hooks, sandboxing, permission-modes, env-vars, tools-reference, interactive-mode, goal); local `node:sqlite` works on Node 24.15.0; tree refs under `refs/cordata/*` survive `git log --all`/`gc`/`fsck` on git 2.34.1; `git checkout <tree> -- .` writes the index, `git restore --source=<tree> --worktree -- .` does not; `bwrap` not installed; Node cold start + sqlite WAL insert 20–40 ms. Headless Stop-hook smoke on Claude Code 2.1.284 (`--model haiku`): block shape and `stop_hook_active` behave as the docs say.

## Resumption notes

- The interview answers are not persisted verbatim; the decisions are. Every branch chose the recommended option except where D-001 records "coding first, generic core".
- If a future session is tempted to reintroduce Pi, Herdr, Tencent, a DAG scheduler or a context compiler, read D-004, D-005, D-008, D-009 and D-011 first; the rejections have stated triggers for revisiting.
- Research briefs produced by subagents contained confident errors about hook contracts; verify host details against the raw `.md` docs (`curl https://code.claude.com/docs/en/<page>.md`) rather than summaries.
