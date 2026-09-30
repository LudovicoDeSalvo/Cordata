# Repository map

Current contents (2026-09-30):

| Path | Purpose |
|---|---|
| `README.md` | Project purpose, status, setup, links |
| `AGENTS.md`, `CLAUDE.md` | Agent entry points, project-memory protocol, commands |
| `package.json`, `tsconfig.json` | One package, no build step (Node ≥ 24.15 runs `.ts`); `npm test`, `npm run typecheck` |
| `src/cli.ts` | Entry point and `bin`: `install`, `new`, `confirm`, `status`, `verify`, `tick`, `done`, `abandon`, `hook <Event>`; user-only guard (D-016) |
| `src/claude.ts` | The only Claude Code-aware file: hook dispatch for all seven events, `installHooks`, `hooksIntact`, sandbox/other-session warnings, installed-hook path check |
| `src/store.ts` | SQLite schema (`node:sqlite`, WAL), `tx`, `event`, bypass log, `CONFIG` constants |
| `src/git.ts` | Repo/project resolution, temp-index `writeTree`, `refs/cordata/*`, info/exclude; strips `GIT_*` env |
| `src/spec.ts` | Task spec parse/validate, package-script resolution, spec version hash, skeleton, default tamper globs |
| `src/task.ts` | Task lifecycle and units: new, confirm, attach, lookups, TAMPER unit (`addTamper`), `done`/`abandon` |
| `src/journal.ts` | Action journal: upsert by `tool_use_id`, NO_RESULT/UNKNOWN closing, effect classifier, Cordata-mention detection |
| `src/verify.ts` | Verifier runner (process groups, timeouts, capped output), the single record path, lease, reuse, tamper check, pruning, Stop gate, `tick` |
| `src/projection.ts` | SessionStart projection, Stop block reason (≤ 4,000 chars), `cordata status` text |
| `test/` | `node:test` suites; `helpers.ts` builds temp repos and pipes hook JSON; `e2e.test.ts` covers E1–E12 |
| `scripts/smoke.sh` | Real headless Claude Code run of the Stop gate (uses plan usage; not in `npm test`) |
| `docs/ARCHITECTURE.md` | v1 architecture; header says what is built |
| `docs/DECISIONS.md` | Accepted decisions D-001 … D-025 and open items |
| `docs/STATUS.md` | Current task snapshot and next actions |
| `docs/research/` | Dated research briefs that ground the decisions |
| `base-docs/` | The three original deep-research inputs. Superseded where they conflict with `docs/DECISIONS.md` |

Not yet created: skills (`skills/cordata-*/SKILL.md`), planned after slice 1.
