# Repository map

Current contents (2026-09-29):

| Path | Purpose |
|---|---|
| `README.md` | Project purpose, status, links |
| `AGENTS.md`, `CLAUDE.md` | Agent entry points and project-memory protocol |
| `docs/ARCHITECTURE.md` | Target v1 architecture |
| `docs/DECISIONS.md` | Accepted decisions D-001 … D-023 and open items |
| `docs/STATUS.md` | Current task snapshot and next actions |
| `docs/research/` | Dated research briefs that ground the decisions (Pi/Herdr, executors, memory, harness SOTA, Claude Code contracts, plan red-team) |
| `base-docs/` | The three original deep-research inputs (spec, review, harness/graph research). Superseded where they conflict with `docs/DECISIONS.md` |

Planned layout for the implementation (not yet created; adjust freely when coding starts):

```
cordata/
├── package.json             # single package: CLI, hook entry, adapter, skills
├── src/
│   ├── cli.ts               # install | new | confirm | status | verify | tick | log | restore | done | abandon | hook <event>
│   ├── adapters/
│   │   └── claude.ts        # Claude Code hook events → core; response shaping
│   ├── core/
│   │   ├── task.ts          # lifecycle, project/worktree resolution
│   │   ├── spec.ts          # task spec file parse, validate, hash
│   │   ├── acceptance.ts    # units, status transitions, reset on spec change
│   │   ├── verify.ts        # snapshot → tamper diff → run units → record
│   │   ├── journal.ts       # actions, effect classifier
│   │   ├── snapshot.ts      # temp-index write-tree, refs/cordata/*, restore
│   │   └── projection.ts    # SessionStart additionalContext text
│   └── store/
│       ├── sqlite.ts        # schema + migrations
│       └── blobs.ts         # content-addressed blob files
├── skills/
│   ├── cordata-new/SKILL.md
│   ├── cordata-status/SKILL.md
│   └── cordata-confirm/SKILL.md
├── test/                    # unit tests + fixture e2e
└── fixtures/demo-repo/      # tiny repo with a failing test for the e2e
```
