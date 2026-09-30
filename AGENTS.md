# Cordata — agent instructions

Cordata is a local, hook-driven tool (no daemon, D-014) that gives Claude Code durable tasks with executable acceptance. Slice 1 is implemented; dogfooding is next. Read `docs/STATUS.md` first.

## Project memory

- At the start of a new task/session, read `docs/STATUS.md` and the overview in `README.md`. Check the current checkout and working changes before trusting the handoff. Read `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` and `docs/TREE.md` selectively for the task at hand. `docs/research/` holds dated evidence briefs; `base-docs/` holds the original inputs and is superseded wherever it conflicts with `docs/DECISIONS.md`.
- Keep this entry point concise. Store project facts in their canonical documents and link to them rather than duplicating them here.
- After meaningful implementation progress, a consequential decision, or a significant discovery, update the affected memory files. Before handing back unfinished work, refresh `docs/STATUS.md` with the current goal, remaining steps, blockers, and actual validation results.
- Preserve current user instructions and user-written documentation. Separate implemented behavior from plans and assumptions. Do not invent test results or historical rationale. Never store secrets.
- Treat `docs/STATUS.md` as a current snapshot; replace stale task details. Put lasting rationale in `docs/DECISIONS.md` using the next `D-nnn` id; never mark a proposal accepted without the user's confirmation. There is no CHANGELOG or release convention yet; do not invent one.
- Do not edit memory for a read-only task or when nothing changed. Checkpoint during substantial work; the last written checkpoint is the handoff.
- If the project-memory skill is available, use its initialize, resume, update, or audit procedure as appropriate. These rules still apply without the skill.

## Working rules

- Decisions D-001 … D-025 are binding. Propose a change as a new decision entry with rationale; do not silently drift back toward the `base-docs/` designs (Pi/Herdr foundation, Tencent memory, DAG scheduler, context compiler, capability router, playbooks). They were rejected for stated reasons.
- Invariants in `docs/ARCHITECTURE.md` ("Invariants" section) must hold in every change: only Cordata's verify path writes unit PASS/FAIL, zero model calls in Cordata, never touch the user's git index/HEAD, no tool-set changes mid-session, transcripts referenced not copied.
- Host contracts (Claude Code hooks, sessions, sandbox) are documented in `docs/research/2026-09-29-claude-code-contracts.md`. Verify against current docs before relying on a detail marked [U].
- Smallest working change. One package, no daemon, no new dependency for what a few lines do.

## Commands

Run from the repo root (Node ≥ 24.15; `.ts` runs directly, no build):

- `npm test` — `node:test` unit suites + fixture e2e (`test/e2e.test.ts`, E1–E12); tests that call user-only verbs strip `CLAUDE_CODE_CHILD_SESSION` themselves.
- `npm run typecheck` — `tsc --noEmit` (strict, erasable syntax only: no enums, namespaces or parameter properties).
- `scripts/smoke.sh` — real headless Claude Code run of the Stop gate (`--model haiku`, uses plan usage); run only when the gate or hook contract changes. It never touches `~/.claude/settings.json` or `~/.cordata`.
- Never run `cordata install` without `--settings <tmp file>` from an agent session: the default target is the user's live `~/.claude/settings.json`.
