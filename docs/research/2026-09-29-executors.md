# Executor harness control surfaces (researched 2026-09-29)

Purpose: what each candidate harness lets an outer runtime control. Subagent web research; [U] = unconfirmed.

Control points: (a) inject/replace context per turn, (b) tool gating/intercept, (c) observe tool results, (d) compaction/persist/resume hooks, (e) headless/SDK, (f) isolated workers, (g) sandbox, (h) multi-provider, (i) prompt-cache friendliness.

| Candidate | a | b | c | d | e | f | g | h | i | License |
|---|---|---|---|---|---|---|---|---|---|---|
| Pi | Yes (`context`, `context_with_system`, `before_provider_request`) | Yes | Yes | Yes | Yes (SDK, RPC, JSON) | Third-party ext | No | Yes | Partial (`cache_warming_decision` hook) | MIT |
| Codex app-server | Partial | Yes (`dynamicTools` experimental) | Yes | Yes | Yes (JSON-RPC stdio/ws/socket) | Yes | Yes (readOnly/workspaceWrite/dangerFullAccess/externalSandbox) | Partial (Responses-API-compatible only) | Partial | Apache-2.0 |
| Claude Agent SDK / Claude Code | Partial (`additionalContext` ≤10k chars, system prompt append; no transcript rewrite) | Yes (PreToolUse allow/deny/ask/defer + updatedInput) | Yes (PostToolUse updatedToolOutput) | Yes (PreCompact blockable, PostCompact, SessionStart(compact), resume/fork, sessionStore) | Yes (`claude -p`, stream-json, SDK) | Yes (agents, Workflow tool, worktree isolation) | Yes (Seatbelt / bubblewrap on Linux+WSL2) | No (Claude only) | Yes (documented; `prompt_cache_likely_expired`) | Proprietary |
| OpenCode | Yes (`experimental.chat.messages.transform`, `chat.system.transform`, `session.compacting`) | Yes | Yes | Yes | Yes (`opencode serve` REST+SSE, OpenAPI) | Yes (subagents, child sessions) | No | Yes (75+) | Unknown | MIT |
| OpenHands SDK | Partial | Yes (no input rewrite) | Partial (observe only) | Yes (condensers, event persistence, fork) | Yes (Python, agent-server) | Yes (sync) | Yes (Docker) | Yes (LiteLLM) | Unknown | MIT |
| Goose | Partial | Partial | Yes | Partial (no compaction hook) | Yes (`goosed`, ACP) | Yes | macOS only | Yes | Unknown | Apache-2.0 |

Details worth keeping:
- Codex hooks (12 events): SessionStart/End, PreToolUse (block/updatedInput/additionalContext), PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, SubagentStart/Stop, Stop (block), Interrupt. Config `~/.codex/hooks.json`, `.codex/`, `config.toml [hooks]`. `dynamicTools` cannot change after `thread/start` (issue #24808), not inherited by subagents (#42565). `prompt_cache_key` per thread; fresh threads don't share first-turn cache (#21796).
- Claude Code hooks: 33 events incl. PreToolUse, PostToolUse, PostToolBatch, UserPromptSubmit, PreCompact, PostCompact, SessionStart, Stop (block), SubagentStart/Stop, PermissionRequest, WorktreeCreate/Remove, FileChanged, TaskCreated/Completed. Types: command, http, mcp_tool, prompt, agent. Transcripts `~/.claude/projects/<cwd>/*.jsonl`. v2.1.277 (Sep 18) AGENTS.md fallback; v2.1.284 (Sep 28).
- OpenCode plugin hooks: `tool.execute.before/after`, `tool.definition`, `permission.ask`, `chat.message/params/headers`, `experimental.chat.system.transform`, `experimental.chat.messages.transform`, `experimental.session.compacting`. Permissions per tool with globs. Compaction keeps ~15k recent tokens.
- Newer harnesses: DeepSeek Harness `dsh` (Aug 2026, MIT, dev preview; plugins provide loops/sandboxes/storage/UI; append-only session log records every context injection), Cline SDK (Apache-2.0, May 2026), Mistral Vibe (Apache-2.0, ACP), Antigravity CLI (replaced Gemini CLI Jun 2026), Factory Droid, Amp, Kimi Code CLI, Qwen Code.

## Implication for Cordata

- With the chosen wedge (durable tasks + executable acceptance), the minimum harness contract is: tool intercept, tool-result observe, completion gate (Stop/agent_end), compaction + session-start hooks, headless run. Every major harness has this. Full transcript rewrite (Pi, OpenCode) is only needed for the context-compiler ambition.
- Sandbox: only Codex and Claude Code ship one. Pi/OpenCode need OS-level isolation added.
