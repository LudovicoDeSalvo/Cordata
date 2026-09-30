# Decisions

Architecture decisions for Cordata. Status `accepted` means the user confirmed it during the 2026-09-29 planning interview. The three documents in `base-docs/` are inputs that these decisions supersede where they conflict.

## D-001: Coding-first product with a domain-neutral core

- Status: accepted
- Date: 2026-09-29
- Context: `base-docs/CORDATA_HARNESS_GRAPH_RESEARCH.md` §27 widens scope to research, personal planning and recurring workflows. Solo part-time capacity.
- Decision: Cordata targets software development. Core entities (Task, Session, AcceptanceUnit, VerificationRun, Action, Artifact) are domain-neutral by construction, but no non-coding adapter, view or workflow is designed or built now.
- Alternatives: coding only with no generic intent (rejected: the entities are neutral anyway at no cost); full AI work environment (rejected: triples surface before first value).
- Consequences: research/recurring features are out of scope until a coding release is in daily use.

## D-002: Solo, own machine, part-time

- Status: accepted
- Date: 2026-09-29
- Decision: First release serves one developer on one machine (WSL2/Linux). No multi-user, ACL, sync, install story, or hosted mode.
- Consequences: no monorepo, no coordinator service, no plugin marketplace. Every package and process must justify itself. Validation bar is practical, not the 37-experiment program in the base docs.

## D-003: Wedge is durable tasks with executable acceptance

- Status: accepted
- Date: 2026-09-29
- Context: Claude Code (the daily driver) has no persistent task list, only a per-session `/goal`; `Workflow` resume is same-session only. No OSS project combines task state + checkpoint + verification for coding agents (see `docs/research/2026-09-29-harness-sota.md`).
- Decision: The one thing Cordata does that the host does not: a task that survives session, compaction, restart and harness switch, whose completion is gated by verifiers the runtime executes on the exact artifact snapshot. Context compilation, harness portability and project memory are secondary properties, not the wedge.
- Alternatives: context compiler (hard to prove, cache-fragile, impossible without transcript rewrite on Claude Code); harness-agnostic control plane (lowest common denominator); fresh project memory (weakest coding evidence, see `docs/research/2026-09-29-memory.md`).

## D-004: Executor v1 is Claude Code through hooks and a local daemon; core is harness-agnostic

- Status: accepted; amended by D-014 (no daemon in v1)
- Date: 2026-09-29
- Context: Billing is a Claude Team premium seat plus ChatGPT Plus; API keys need company permission and are avoided. Anthropic's legal page restricts subscription OAuth to Claude Code and native apps; third-party harnesses on a Claude login bill extra usage per token since 2026-04-04. `claude -p` and the Agent SDK are covered by the seat today, but a per-seat change was announced and paused (June 2026).
- Decision: Cordata core (task, acceptance, action journal, snapshots) runs in one local daemon with its own SQLite store. The first adapter is Claude Code hooks: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`/`PostCompact`, `Stop`. Adapter contract is these ~5 event kinds, so a Codex adapter (ChatGPT Plus login) can be added later. Core never imports host types. Core never requires headless model calls.
- Alternatives: Pi extension (rejected, see D-005); Pi SDK on `pi-durable`/Pico5 (rejected: Pico5 is an unimplemented durable-execution primitive, not a work-item model); Claude-only daemon with no adapter seam (rejected: seam is cheap and keeps Codex open).
- Consequences: no transcript rewrite. Context influence is limited to `additionalContext` at SessionStart/UserPromptSubmit/PostToolUse and Stop-block reasons. Acceptable given D-003.
- References: `docs/research/2026-09-29-claude-code-contracts.md`, `docs/research/2026-09-29-executors.md`.

## D-005: Pi and Herdr are not part of the core

- Status: accepted
- Date: 2026-09-29
- Context: Both are real and large (Pi ~110k stars, Herdr ~41k). The base docs assumed Pi + Herdr as foundation.
- Decision: Pi is not the v1 executor: subscription auth is a ToS violation and bills per token; its advantages (transcript rewrite, multi-provider) are not the wedge. Herdr is not required: v1 has one executor, Claude Code owns worktrees (`WorktreeCreate` hook), and Herdr can only observe Claude Code by screen detection, so it cannot be state authority. Herdr may later host an optional sidebar plugin showing task/acceptance state.
- Revisit when: billing changes to API keys, or a Pi/Codex adapter is wanted, or parallel workers justify a process manager.

## D-006: TypeScript on Node, one package, SQLite

- Status: accepted; amended by D-014 (no daemon; `node:sqlite` chosen)
- Date: 2026-09-29
- Decision: Single Node/TypeScript package containing daemon, CLI and Claude Code adapter. SQLite via `node:sqlite` or `better-sqlite3` (pick at implementation). Hook transport is decided in D-013 (one `command` shim for every event). No pnpm workspaces, no Fastify, no OpenTelemetry, no hash chain.
- Alternatives: Rust (single binary, but every adapter crosses a process boundary and slows a solo TS developer); Python (weak fit for Claude/Codex tooling).

## D-007: Tool gating happens per call at PreToolUse; the allowed-tool set never changes mid-session

- Status: accepted
- Date: 2026-09-29
- Context: Anthropic's prompt-cache docs: denying an entire tool or changing tool sets invalidates the cache. The spec's Capability Router swapped tool sets per DAG node.
- Decision: Policy is enforced by `PreToolUse` allow/deny/ask with reasons. No capability router.

## D-008: Task model v1

- Status: accepted; amended by D-015 (Stop gate trigger), D-016 (who confirms), D-021 (spec version scope, DONE rule)
- Date: 2026-09-29
- Decision:
  - Tasks are created explicitly (slash command or CLI). Every Claude Code session in that repo/worktree auto-attaches to the active task at `SessionStart`. Sessions without an active task are untracked and ungated.
  - Acceptance units are drafted by the model at task start, confirmed once by the user, versioned on edit. The daemon rejects a unit that has neither a verifier command nor an explicit `MANUAL` tag.
  - The model runs tests freely during work; those runs are evidence only. When Claude tries to stop, the daemon runs the declared verifiers itself on the exact worktree snapshot and binds PASS/FAIL to the git tree hash. Any FAIL blocks Stop with the failure as reason (respecting the host's block cap).
  - Schema carries `parentId` and `after[]` for sub-tasks; v1 logic and UI handle one task with a checklist. No DAG scheduler.
- Alternatives: per-prompt auto tasks (noisy); hand-written criteria only (slow start); model-graded acceptance (no independent evidence); full DAG (bookkeeping before value).

## D-009: No remote semantic memory and no LLM-consolidated memory in the core

- Status: accepted
- Date: 2026-09-29
- Context: TencentDB Agent Memory is early (data-loss issue #1523, proxy injection, cloud LLM requirement). VibeMemBench (2609.23570): 11/12 memory systems below memory-off on SWE-bench; "Useful Memories Become Faulty" (2605.12978): consolidation degrades; EA-Graph (2608.04278): artifact-anchored verified claims beat prose notes.
- Decision: Memory in Cordata = raw retained evidence + acceptance-anchored claims + human-editable markdown. No Tencent, no Mem0-style extraction, no playbook/plan-cache pipelines. A provider seam may exist later only if a measured need appears.
- References: `docs/research/2026-09-29-memory.md`.

## D-010: Journal, snapshots, evidence, manual units

- Status: accepted; amended by D-017 (journal scope), D-022 (snapshot retention)
- Date: 2026-09-29
- Decision:
  - No `Attempt` entity. A task has session attachments (host session id + transcript path) and verification runs (one per Stop, bound to a tree hash).
  - Action journal: `PreToolUse` writes intent (tool, input hash, effect class READ / LOCAL_WRITE / REMOTE_WRITE / DESTRUCTIVE from tool name plus Bash command heuristics); `PostToolUse` closes it with output reference. On `SessionStart`, unclosed actions are listed to the model as "outcome unknown, verify". No automatic retry or reconciliation.
  - Snapshots: per verification run, a git tree object written through a temporary index (`git add -A` + `write-tree`) and pinned under `refs/cordata/<task>/<run>`. User index and HEAD untouched. Tree hash is the acceptance binding. Restore = checkout of that tree into the worktree. Ignored files are excluded by design.
  - Evidence kept by the daemon: hook payloads (tool inputs; outputs above a size threshold go to blob files with an excerpt in SQLite), verifier stdout/stderr, snapshot refs. Host transcripts are referenced, never copied.
  - `MANUAL` acceptance units never block Stop. Task state becomes `VERIFIED_PENDING_MANUAL` until the user ticks them via CLI or slash command; pending units are shown at the next `SessionStart`.
- Alternatives: full durable-execution journal with idempotency and reconciliation (deferred until a real crash case demands it); `/rewind` checkpoints (session-bound, not queryable); transcript copies (unstable format, duplication).

## D-011: Context, code intelligence, verifier registry, tampering

- Status: accepted; amended by D-017 (registry scan deferred), D-020 (tamper detection), D-023 (projection sources and size)
- Date: 2026-09-29
- Decision:
  - Context: v1 injects a task projection (goal, acceptance units with status, last verification result, unclosed actions, pending manual units, constraints) at `SessionStart` for startup, resume and compact. Nothing else. Observation packing (large tool outputs to blob, excerpt + handle in context via `PostToolUse.updatedToolOutput`) is deferred to v1.1 after the wedge is in daily use. No context compiler, no budgets, no scoring.
  - Code intelligence: none in Cordata. Claude Code's LSP tool and grep are used as-is.
  - Verifier registry: per project, discovered once (package scripts, CI workflows, lint/type/test config) and stored with command, safety class, last PASS tree hash and duration. Offered as candidates when acceptance units are drafted. Never executed outside a task.
  - Tampering: at each verification run, files matching configured verifier globs (tests, CI, lint/type config) are diffed against the task-start tree. Any change auto-adds a `MANUAL` unit "review modified verifier files: …". Executable PASS still allows Stop; task remains `VERIFIED_PENDING_MANUAL`.
- Rationale: Compaction Cliff (2608.22752) for re-injection; SoL-Pi and Complexity Trap for packing value but not wedge; host already has LSP; tampering is a documented failure mode and the diff is cheap.

## D-012: Isolation, concurrency, interface, learning

- Status: accepted; amended by D-016 (skills do not run user-only verbs), D-019 (verifier sandboxing)
- Date: 2026-09-29
- Decision:
  - Isolation: Cordata enforces no permissions in v1. `PreToolUse` journals and classifies only. Claude Code permissions and its bubblewrap sandbox are the boundary; enabling the sandbox is a documented setup step. Daemon-run verifiers execute unsandboxed with the user's environment because they are the user's own project commands.
  - Concurrency: one task binds to one repo worktree. Parallel work is separate tasks in separate worktrees. Claude Code subagents and the `Workflow` tool run untouched inside sessions; their tool calls are journaled like any other. Several sessions may attach to one task; each Stop is gated independently.
  - Interface: CLI (`cordata new | status | tick | log | restore | confirm`) plus matching Claude Code slash commands/skills, plus the `SessionStart` projection. No TUI, web UI or Herdr plugin in v1.
  - Learning: cut. The verifier registry and task history are the only cross-task reuse. Reusable procedures are hand-written Claude Code skills outside Cordata.
- Alternatives rejected for v1: task-scoped path policy, full policy engine, subagent coordination, worker DAG, TUI pane, Herdr plugin, offline procedure extraction, ACE playbook.
- Revisit when: dogfooding shows repeated task families (learning), or a second executor with weaker permissions appears (isolation).

## D-013: Validation bar, task spec file, storage, daemon lifecycle

- Status: accepted; amended by D-014 (daemon lifecycle replaced by per-event hook process), D-021 (spec hash scope), D-022 (project id, repo footprint)
- Date: 2026-09-29
- Decision:
  - Validation: unit tests (task state machine, spec parse/validate/hash, snapshot + restore, verifier runner, effect classifier), one fixture-repo end-to-end (create task, edit, Stop blocked by failing test, fix, Stop passes, daemon killed mid-session, resume lists unclosed actions), then dogfooding on the user's own repositories with a log of false blocks and time-to-resume. No benchmark program. The 37 experiments in `base-docs/` are not adopted.
  - Task spec: `<repo>/.cordata/tasks/<id>.md`, YAML frontmatter for units, markdown body for goal, constraints and notes. The model drafts it with its Edit tool; `cordata confirm` validates, hashes and versions it. Runtime state (attachments, actions, runs, snapshots) lives in SQLite.
  - Storage: SQLite database and blobs in `~/.cordata/<project-id>/`; project id = canonical root + git remote fingerprint. `<repo>/.cordata/` holds task specs and repo config, gitignored by default; the user may commit it. Snapshot trees live in the repo's own `.git` under `refs/cordata/*`.
  - Daemon: every hook event goes through one `command` hook shim (`sh` + `curl`) that POSTs the event JSON to the daemon over a Unix socket and starts the daemon if it is down. Daemon exits after an idle timeout. No systemd, no `http` hook type, no per-event Node startup.
- Alternatives: paired SWE-bench-style runs (usage cost, weak statistics); SQLite-only spec edited via CLI (awkward for prose); markdown-only truth (parsing on every hook); everything inside the repo (worktrees would not share state); http hooks (Stop unsupported per docs, no auto-start).

## D-014: No daemon in v1; one Node process per hook event

- Status: accepted
- Date: 2026-09-29
- Context: D-006/D-013 justified a daemon by per-tool-call hook latency. Measured 2026-09-29: Node 24.15 cold start + `node:sqlite` open + WAL insert = 20–40 ms. Red-team F7 (daemon keeps a stale environment), F18 (spawn/socket races), F4/F5 (daemon-down fail-open, forgeable socket) all stem from the daemon.
- Decision: Every hook is a `command` hook running `cordata hook <event>`, a Node entry point in the same package. `SessionStart`, `UserPromptSubmit` and `Stop` run synchronously; the journal hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`) run with `async: true`. State is SQLite via `node:sqlite` in WAL mode with a busy timeout; each process opens, writes in a transaction, and exits. Verifiers run inside the Stop hook process (or `cordata verify`), so they inherit the session's own environment. No socket, no sh/curl shim, no idle timeout.
- Rationale: removes a process, a transport and three failure classes for a latency cost that measurement shows is negligible and that async hooks hide entirely.
- Alternatives: keep the daemon with an environment handoff and `flock` (rejected: more moving parts without a measured need).
- Consequences: "one writer process" becomes "one code path": all writes go through the core module, and only the verify path writes PASS/FAIL. Async hook completion order is not guaranteed, so actions upsert by `tool_use_id`. Hook stdout must be the JSON response only.
- Revisit when: synchronous hook latency above ~200 ms or `SQLITE_BUSY` failures observed in dogfooding.
- References: `docs/research/2026-09-29-plan-redteam.md`; amends D-004, D-006, D-013.

## D-015: Stop gate runs only on a completion claim over a changed tree

- Status: accepted
- Date: 2026-09-29
- Context: `Stop` fires after every turn, so gating every Stop blocks clarifying questions, TDD red steps, progress reports and unrelated Q&A, and adds verifier runtime to every turn (red-team F2; the same pitfalls are reported for existing Stop-hook gates). `stop_hook_active` is true from the second Stop of a continuation chain, not after 7 blocks, so the planned "allow when `stop_hook_active`" would block at most once (F1, confirmed by a headless smoke on Claude Code 2.1.284). The block response is top-level `{"decision":"block","reason":...}` (F3).
- Decision: On `Stop`, run the EXEC units only when all hold: an ACTIVE task is attached; `background_tasks` is empty; the Stop `cwd` resolves to the task's worktree; `last_assistant_message` contains the completion marker documented in the projection (e.g. `[cordata:ready]`); and the current tree differs from the tree of Cordata's last run for this task and spec version. A repeated claim on an unchanged tree reuses the last result and does not block again. Otherwise allow without running anything. On FAIL, block with top-level `decision`/`reason`. `stop_hook_active` never short-circuits the gate; `false` only resets Cordata's consecutive-fail counter, and after 3 consecutive FAIL runs in a chain Cordata allows the stop (host cap is 8).
- Alternatives: verify whenever the tree changed unless the message ends with a question (blocks TDD red steps and progress reports); every Stop (original plan).
- Consequences: a false "done" stated without the marker is not blocked, but the task stays ACTIVE and the projection and `cordata status` show it unverified; DONE is still reachable only through PASS. Marker compliance is a dogfooding metric.
- Revisit when: dogfooding shows unmarked completion claims are common (add a completion-phrase heuristic).
- References: `docs/research/2026-09-29-plan-redteam.md` F1–F3; amends D-008.

## D-016: Threat model and user-only commands

- Status: accepted
- Date: 2026-09-29
- Context: `cordata confirm | tick | done | abandon` were reachable by the model through its Bash tool, and the planned confirm skill had the model run `confirm`, so "confirmed by the user" meant "confirmed by the model" (red-team F5).
- Decision: The model is untrusted but not assumed to be a deliberate adversary with the user's uid: Cordata aims to be tamper-evident against drift and reward hacking, not tamper-proof. The user-only verbs refuse to run when `CLAUDE_CODE_CHILD_SESSION=1`, which Claude Code sets in its Bash and hook subprocesses. Skills draft or edit the spec and then ask the user to run the command in their own terminal. A journaled Bash command that mentions a user-only verb, `~/.cordata` or the Cordata database adds a MANUAL tamper unit to the attached task.
- Alternatives: additionally write ask/deny permission rules for `Bash(cordata confirm:*)` etc. (bypassable, extra prompts); no guard.
- Consequences: `env -u` or direct SQLite writes still bypass the check, but leave a journal trace. [U] whether Claude Code's `!` shell mode sets the variable; if it does, the user needs a separate terminal.
- References: `docs/research/2026-09-29-plan-redteam.md` F5; amends D-008, D-012.

## D-017: Journal scope; slice-1 cuts

- Status: accepted
- Date: 2026-09-29
- Context: `PreToolUse` fires before the permission check; a manually denied dialog fires no later event, `PermissionDenied` fires only in auto mode, a failed tool fires `PostToolUseFailure`, and an interrupt fires no Stop. Unclosed actions would therefore be mostly denials and interrupts, not crashes. READ-class calls dominate hook traffic and carry no value (red-team F12).
- Decision: Journal only `Bash|Edit|Write|NotebookEdit|mcp__.*` via hook matchers on `PreToolUse`, `PostToolUse` and `PostToolUseFailure`. At a session's next `Stop` or `UserPromptSubmit`, its still-open actions close as NO_RESULT; only actions still open when a session produced neither are shown as UNKNOWN. Action outcome ∈ OK, ERROR, NO_RESULT, UNKNOWN. Cut from slice 1: the `PreCompact` hook (`SessionStart(compact)` already re-injects) and the verifier registry scan (the model reads package scripts and CI itself when drafting units).
- Consequences: less hook traffic, and the unknown-outcome list means what it says. The registry returns only with evidence.
- Revisit when: drafting picks weak or wrong verifier commands in dogfooding (registry).
- References: `docs/research/2026-09-29-plan-redteam.md` F12; amends D-010, D-011.

## D-018: Gate robustness: failure mode, budget, verdicts, concurrency, tree check

- Status: accepted
- Date: 2026-09-29
- Context: red-team F4 (every failure is silently fail-open; a timed-out hook renders no decision), F8 (verifiers run in the live worktree and can see it change), F9 (several sessions may claim at once), F21 (blocking on infrastructure errors makes the model flail).
- Decision:
  - Failure mode: fail-open, loudly. The hook catches everything and exits 0; any bypass (internal error, budget exhaustion, lock timeout) is recorded as a `GATE_BYPASS` TaskEvent (fallback `~/.cordata/bypass.log` if the DB is unwritable) and shown in the next projection and `cordata status`.
  - Budget: `cordata install` writes the Stop hook with `timeout: 1800`. Cordata's run budget is the hook timeout − 60 s; units still running at the budget are killed and marked ERROR.
  - Verdicts: FAIL = verifier exited non-zero. ERROR = exit 126/127, unit timeout or budget kill, spawn failure, or tree mismatch. The first ERROR in a continuation chain blocks with a reason marked as an infrastructure error; a second ERROR allows the stop with a note. FAIL keeps the D-015 cap of 3. The task stays ACTIVE either way.
  - Tree check: write the tree before and after the run; a mismatch makes the run ERROR ("worktree changed during verification"), never PASS. Verifier commands must not write files (`--check`, not `--write`).
  - Concurrency: one run per task at a time, held by a lease row in SQLite (pid, startedAt; stale when the pid is dead). A second claim waits within its budget, then reuses the result if (tree, specVersion) still matches, else runs. The projection notes another session active on the task in the last 30 min.
- Alternatives: fail-closed on caught errors (a Cordata bug loops every claim, and uncaught crashes fail open anyway); per-task hook timeout rewritten at confirm (writes Claude config mid-session); isolated checkout per run (no node_modules/.env, slow); skip or refuse concurrent claims.
- Consequences: invariant 2 now reads "PASS = verifiers exited 0 on a worktree whose non-ignored content was tree X throughout"; gitignored inputs are not covered. Suites longer than ~29 min can never pass the gate.
- References: `docs/research/2026-09-29-plan-redteam.md` F4, F8, F9, F21.

## D-019: Verifier sandboxing deferred, with a warning

- Status: accepted
- Date: 2026-09-29
- Context: hook processes run outside Claude Code's sandbox, so gated verifiers run model-authored code with the user's environment and no permission prompt (F6). No escalation today (bwrap not installed, sandbox off), but D-012 recommends enabling the sandbox.
- Decision: v1 runs verifiers unsandboxed. `cordata install` and every SessionStart projection warn when `sandbox.enabled` is true: "Cordata verifiers run outside the sandbox".
- Alternatives: wrap with `@anthropic-ai/sandbox-runtime` in v1 (unverified CLI); skip the gate whenever the sandbox is on (gate dies when following D-012).
- Revisit when: the user enables the Claude Code sandbox; then wrap verifiers with sandbox-runtime using the same filesystem and network rules.
- References: F6; amends D-012.

## D-020: Tamper detection v1

- Status: accepted
- Date: 2026-09-29
- Context: F11: script indirection, unspecified config globs, live hook removal via settings, model-editable glob config, gitignored files invisible to a tree diff; F19b: merges and rebases would re-flag the same files every run.
- Decision:
  - Scripts: at `confirm`, commands of the form `npm test`, `npm run X` (and pnpm/yarn equivalents) are resolved to the script text and stored; a change at any run adds a tamper MANUAL unit. Makefile targets later.
  - Default globs: `**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/tests/**`, `**/__tests__/**`, `conftest.py`, `vitest.config.*`, `jest.config.*`, `playwright.config.*`, `tsconfig*.json`, `eslint.config.*`, `.eslintrc*`, `pytest.ini`, `tox.ini`, `setup.cfg`, `pyproject.toml`, `.github/workflows/**`.
  - Settings: a `ConfigChange` hook records any change that removes Cordata's hooks or sets `disableAllHooks` and adds a tamper MANUAL unit; it does not block.
  - Config freeze: tamper globs and the fail cap are copied into SQLite at `confirm` as part of the confirmed version; edits to `.cordata/config.json` apply only after the next confirm.
  - Dedup: a tamper unit lists (path, blob hash) pairs; ticking it accepts exactly that content; later runs flag only paths whose content changed again.
  - Scope: gitignored files are not diffed (documented).
- Alternatives: `package.json` in globs (flags every dependency change); blocking `ConfigChange` (blocks the user too); live config; a `cordata baseline` command.
- Revisit when: dogfooding shows test weakening the glob diff misses; then AST-level checks in the style of proof-of-done.
- References: F11, F19; amends D-011.

## D-021: Confirmed spec version and the DONE rule

- Status: accepted
- Date: 2026-09-29
- Context: hashing the whole spec file resets all units on every Notes edit (F15); a PASS followed by more edits and a manual tick produced DONE on an unverified tree (F16).
- Decision:
  - specVersion = hash of the normalized units (id, kind, description, command, cwd, timeoutMs), the Goal and Constraints sections, the frozen config (D-020) and the resolved scripts (D-020). Title and Notes are free text. When the file drifts from the confirmed version, the projection says what changed; the gate keeps using the confirmed units until the user confirms again, which resets unit statuses.
  - DONE requires every EXEC unit PASS on the current tree and every MANUAL unit TICKED. `cordata tick` records the tick with its tree; if the current tree differs from the last PASS tree, it runs the EXEC units in the user's terminal: PASS → DONE, FAIL → ACTIVE.
  - Ticks persist after later tree changes; new tamper content still adds new tamper units.
- Alternatives: units-only hash (Goal/Constraints drift unseen); whole-file hash; tick refuses and asks for `cordata verify`; ticks invalidated by any tree change.
- References: F15, F16; amends D-008, D-013.

## D-022: Project identity, install, repo footprint, snapshot retention

- Status: accepted
- Date: 2026-09-29
- Context: root + remote fingerprint split worktrees into separate DBs whose per-DB task ids collide under the shared `refs/cordata/*`, and changed when remotes changed (F13). `init` edited tracked `.gitignore` and committed settings, and per-worktree hook settings leave new worktrees ungated (F14). Refs pinned every run forever and large untracked files were hashed into `.git/objects` (F20).
- Decision:
  - Project id = hash of `realpath(git rev-parse --git-common-dir)`; all worktrees of a repo share one DB and one task-id sequence.
  - `cordata install` (once) writes the hooks to `~/.claude/settings.json`; they are inert without an attached task. No per-repo `init`: `cordata new` creates `.cordata/` on first use and adds it to `.git/info/exclude`.
  - Retention: while a task is open keep `startTree`, the last PASS and the last 5 runs; after DONE or ABANDONED keep `startTree` and the final PASS for 30 days (retention-days setting), then delete refs and blobs. Pruning runs at the end of each verification.
  - Before `git add -A`, untracked non-ignored files over 10 MB (configurable) are listed in the gate result and projection ("consider .gitignore"); they are still included so the binding stays exact.
- Alternatives: UUID in git config (survives repo moves; writes `.git/config`); per-worktree `settings.local.json`; committed settings; `.gitignore`; keep all runs; ERROR on large files.
- Revisit when: a repo move orphans state (store the id in git config).
- References: F13, F14, F20; amends D-010, D-013.

## D-023: Projection size, wording, sources, drift notes

- Status: accepted
- Date: 2026-09-29
- Context: `additionalContext` over 10,000 chars is offloaded to a file with a 2,000-char preview; imperative system-style text can trip prompt-injection defenses; the plan injected on 3 of 5 SessionStart sources (F17). Branch switches in the task worktree were unhandled (F19a).
- Decision: the projection and the Stop block reason are capped at ~4,000 chars; overflow trims stderr excerpts first (keep first and last lines per failure), then collapses lists to "+N more", and always ends with "full state: `cordata status`". Wording is factual. Inject on `startup`, `resume`, `clear`, `compact` and `fork`; a fork attaches its new session id. When HEAD differs from `branchAtCreation`, the projection and gate result note it; the gate still runs.
- Alternatives: use the full 10k; skip fork; skip or rebind the gate on a branch switch.
- References: F17, F19; amends D-011.

## Open items (not decisions)

- License if ever published: undecided; MIT likely.
- Stop-gate fail cap: default 3 consecutive FAIL runs per continuation chain (D-015); tune in dogfooding.
