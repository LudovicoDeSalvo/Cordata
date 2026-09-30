# Claude Code contracts relevant to Cordata (verified 2026-09-29)

Source: official docs via claude-code-guide subagent. URLs: https://code.claude.com/docs/en/hooks.md , hooks-guide.md , sessions.md , workflows.md , goal.md , worktrees.md , headless.md , sandboxing.md , prompt-caching.md. Items marked [U] unconfirmed or contradicted by other sources.

## Hooks

- Types: `command`, `http`, `mcp_tool`, `prompt`, `agent`.
- `http`: POST event JSON (same as command stdin); response JSON same as command hooks; fields `url`, `headers`, `allowedEnvVars`. Supported on `Stop` and tool events; **not** on `SessionStart` or `Setup` (command / mcp_tool only). Connection failure, non-2xx, bad JSON = non-blocking error. Default timeout 600 s for command/http/mcp_tool (30 s UserPromptSubmit/Pre/PostModelSwitch; 10 s MessageDisplay). A timed-out hook's output is discarded: no decision (fail-open). Corrected 2026-09-29, see `2026-09-29-plan-redteam.md`.
- `Stop`: blocks with top-level `{"decision":"block","reason":"..."}` (not inside `hookSpecificOutput`) or exit 2 + stderr; `hookSpecificOutput.additionalContext` also continues the turn. Input adds `stop_hook_active` (true when the turn is already continuing because of a stop hook, i.e. after the first block), `last_assistant_message`, `background_tasks`, `session_crons`. Host overrides the block after 8 consecutive continuations; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises it. Fires every turn; not on user interrupt; API errors fire `StopFailure`. `SubagentStop` same contract. Corrected 2026-09-29.
- `PreToolUse`: `permissionDecision` allow | deny | ask | defer (defer = `-p` only, tool call preserved for SDK wrapper); `updatedInput` rewrites args. `PostToolUse`: `updatedToolOutput`, `additionalContext`. `PostToolUseFailure` (tool started and failed), `PostToolBatch` exist. `PreToolUse` fires before the permission check; a manually denied dialog fires no later event; `PermissionDenied` fires only in auto mode.
- `PreCompact` / `PostCompact` matchers manual | auto. `SessionStart` matchers startup | resume | clear | compact | fork; can inject `additionalContext`, set `sessionTitle`, `watchPaths`. `additionalContext` is capped at 10,000 chars (beyond: written to a file, 2,000-char preview); phrase it as facts, imperative "system" text can trip prompt-injection defenses. `prompt_cache_likely_expired` exists on resume/fork (v2.1.251+). Settings-file hook edits are picked up live by a file watcher.
- Other payloads: `FileChanged` {file_path, changed_reason}, `CwdChanged` {cwd}, `InstructionsLoaded` {source, file_path}, `ConfigChange` {source, file_path}. `TaskCreated` / `TaskCompleted` belong to the native Task tools; `TaskCompleted` exit 2 blocks marking a task complete.

## Tasks, goals, workflows

- Native Task tools (`TaskCreate/Get/List/Update`) exist; the list persists across compaction and can be shared across sessions via `CLAUDE_CODE_TASK_LIST_ID` (`~/.claude/tasks/`). Off by default on models newer than Opus 4.7 / Sonnet 4.6 unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. No acceptance or verification. `/goal` = completion condition evaluated by a small model after each turn; restored on resume if active; session-bound; no external API.
- `Workflow` tool: `agent()`, `parallel()`, `pipeline()`, `phase()`; subagents may use `isolation: "worktree"`; results saved per run under `~/.claude/projects/...`; `resumeFromRunId` is same-session only (from the tool schema in this session). Not a cross-session durable task system.
- Worktrees: `WorktreeCreate` hook (returns path, replaces `git worktree add`), `WorktreeRemove` hook; `EnterWorktree` / `ExitWorktree` tools; isolation enforced on edits, cwd, git.

## Sessions

- Transcripts: `~/.claude/projects/<project-name>/<session-id>.jsonl`; internal format, not stable; do not read live. Use hooks (`transcript_path`), `/export`, or `claude -p --resume <id> --output-format json`.
- `--resume`, `--continue`, `--fork-session`, Agent SDK `sessionStore` adapter.

## Environment

- `CLAUDECODE=1` in Bash/hook/MCP subprocesses (also IDE terminals); `CLAUDE_CODE_CHILD_SESSION=1` only in Claude Code-spawned Bash/Monitor/hook/statusline subprocesses; also set in the user's `!` shell mode (observed 2026-09-30).

## Headless and billing

- `claude -p` and Agent SDK run under subscription login and count against plan usage (docs per guide agent). `--bare` skips subscription config and uses API key only.

## Sandbox

- Linux/WSL2: bubblewrap + optional seccomp (seccomp adds Unix-socket blocking; without it sandboxed commands can reach local sockets); sandboxed writes to `.claude` settings/hooks are denied; primitives packaged standalone as `@anthropic-ai/sandbox-runtime`. `bwrap` not installed on the dev machine (2026-09-29). `sandbox.mode` restrict | monitor | unrestricted; `allowRead`, `allowWrite`, `excludePaths`; network `allowedDomains`, `blockDomains`; DNS leaks, no TLS inspection. WSL2 confirmed.

## Prompt cache

- Prefix order: system + tools → CLAUDE.md / memory / rules → conversation. Deferred tool schemas via tool search.
- Invalidates: model switch, effort change (some models exempt), fast mode, MCP connect/disconnect if not deferred, plugin enable/disable, denying an entire tool if not deferred, `/compact`.
- Keeps: file edits, CLAUDE.md edits mid-session, permission-mode change, skill invoke, `/rewind`, subagent spawn.
- Consequence: gate tools per call at `PreToolUse`; never toggle the allowed-tool set mid-session.

## Pi Pico5 task shape (for compatibility notes)

`{ id, conversationId, kind, version, input, after: TaskId[], background, abortRequested, state: pending(checkpoint) | running(checkpoint) | terminal(outcome), memos }`. Handler-driven phases; on reopen, running → pending with checkpoint preserved; tool calls durably record args + replay policy before execute; documents are Chord-tracked JSON with scope session | conversation | task and fork policy asOf | current | initial. No verification, acceptance, artifacts, git, or worktrees.

Reading: Pico5 is a durable-execution primitive for the harness's own operations, like a Temporal workflow. Cordata's Task is a work item (goal, acceptance, artifacts). Different layers; no schema coupling needed.
