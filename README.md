# Cordata

Durable tasks with executable acceptance for Claude Code.

Cordata is a local, hook-driven tool (no daemon) that keeps a coding task alive outside the model session: goal, acceptance units, verification runs, an action journal and workspace snapshots. When Claude claims the task is complete, Cordata runs the declared verifiers itself on a pinned worktree snapshot and blocks stopping until they pass. Manual acceptance units and modified test files keep the task open until the user reviews them.

## Status

Slice 1, milestone A works (2026-09-30): create and confirm a task, `SessionStart` projection, and the `Stop` gate that runs the EXEC units on a pinned snapshot when Claude's final message contains `[cordata:ready]`. Journal, tamper detection and `tick` (milestone B) are next; see `docs/STATUS.md`.

## Setup (dogfooding)

Requires Node ≥ 24.15 and git ≥ 2.31. No build step.

```sh
npm install && npm link        # in this repo; puts `cordata` on PATH
cordata install                # once: adds hooks to ~/.claude/settings.json (backup written)
cd <your repo>
cordata new "Add refresh tokens"   # writes .cordata/tasks/t-0001.md; fill in units and Goal
cordata confirm                    # in your own terminal, not through Claude (D-016)
```

`cordata status` shows the task, runs, snapshot restore commands and sessions; `cordata verify` runs the units on demand.

## Intended v1 capabilities

- Create a task in a repo worktree; a markdown spec with acceptance units the model drafts and the user confirms.
- Every Claude Code session in that worktree attaches to the task and receives a projection of its state, including after compaction or resume.
- Write-capable tool calls (Bash, Edit, Write, MCP) are journaled with a heuristic effect class; calls left open by a dead session are surfaced as unknown-outcome.
- On a Stop that claims completion over a changed tree, verifiers run on a git tree snapshot pinned under `refs/cordata/*`; failures block stopping with the evidence.
- Changed test/CI/lint files since task start add a manual review unit.
- CLI to confirm, verify, tick manual units (user-only commands refuse to run from inside Claude Code), inspect runs, restore a snapshot, and find the session to resume.

Not in v1: memory extraction, context compilation, capability routing, multi-agent scheduling, permissions, TUI, any remote service, any model call from Cordata.

## Constraints that shaped it

Solo developer, part-time, own WSL2 machine, Claude Team seat as the only model access. See `docs/DECISIONS.md` D-002, D-004, D-005.

## Documentation

- `docs/ARCHITECTURE.md` — target architecture, data model, flows, invariants
- `docs/DECISIONS.md` — accepted decisions with rationale and rejected alternatives
- `docs/STATUS.md` — current state and next actions
- `docs/TREE.md` — repository map
- `docs/research/` — dated research briefs
- `base-docs/` — original research inputs, superseded where they conflict with decisions
- `AGENTS.md` — working rules for agents
