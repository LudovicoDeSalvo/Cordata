# Harness engineering, context, durable execution, code intelligence, multi-agent (researched 2026-09-29)

Subagent web research. [C] fetched primary source, [S] secondary only, [U] unconfirmed. Numbers are author-reported.

## A. Harness engineering

- OpenAI "Harness engineering" (2026-02-11) [S]: ~100-line AGENTS.md as map to `docs/`; custom linters whose error messages inject the fix; doc-gardening agents; caution on tool count.
- LangChain (2026-02-17) [C]: Terminal-Bench 2.0 52.8%→66.5% with fixed model. Techniques: build-verify loop; local-context middleware (dir tree + tools at start); pre-completion checklist intercept; loop-detection on repeated edits; "reasoning sandwich" (high effort plan/verify, low implement); time-budget warnings.
- Google "Anatomy of harness engineering" (2026-09-09) [C]: behavioral evals asserting on intermediate actions; fast deterministic suite (<5s); LLM-judge only for fuzzy cases; track aggregate pass rate.
- Anthropic: long-running harnesses (2025-11-26): initializer writes init.sh, progress file, feature-list JSON, initial commit; one feature per session, commit, e2e verify. "Prompt caching is everything" (2026-04-30): deferred tool stubs, plan mode as tools not tool-set swaps, compaction as cache-safe fork. C-compiler run (2026-02-05): 16 parallel agents, lock files in git, test quality is the ceiling.
- Meta-Harness (2603.28052): automated harness search gains. "Rethinking harness-evolution eval" (2607.12227): auto evolution does not consistently beat equal-compute test-time scaling; weak held-out generalization.
- Sep 2026: "Empirical Study of Harness Design" (2609.20804): 176 settings, 4 models — rule-based elision before LLM summarization; drop recall tool; planning helps weak models only; bash-capable models want bare shell. SoL-Pi (NVIDIA, 2609.20519): Action Fusion (edit+command one call), ObservationPack (big outputs to disk, handle+excerpt), Evidence-Preserving Reducer, Online Context Compact → −45–49% tokens, score within ~6%. "Harness or Model?" (2609.11987): vendor-native vs neutral harness ±1.25pp overall, large per-category swings. Marmelab state-of-field (2026-09-24) [S]: reviewer agent hurt (41→33%); >4 handoffs almost always failed; per-action approval beats up-front rules by 20pp.

Convergent techniques: verify-before-done gate; small instruction map + on-demand docs/skills; enforcement in code not prose; progress/state files + git commits as cross-session memory; fresh context per unit of work with structured handoff; behavioral evals + traces; loop/time-budget detection; staged context management (elide → summarize); minimal tool surface, bare shell for strong models; cache-stable prompt layout.

## B. Context management

- Complexity Trap (2508.21433): observation masking halves cost, matches/exceeds LLM summarization on SWE-bench Verified. CoACT (2607.02911): −33% tokens same solve rate. AttnCompress (2609.08318): −42% tokens. TRACE (2608.06503): compression weakens recency, raises blocked actions and variance; evaluate by re-simulating from boundary. SWE-Compressor (2512.22087): compaction as agent-callable tool at milestones. Don't Break the Cache (2601.06007): 41–80% cost, 13–31% TTFT; dynamic content last. Cost attribution (2609.22114): tool-schema filtering saves 21–57k tokens/turn. Implicit embedding compression fails on SWE-bench (2605.11051). ICLR (2609.29875): drop old reasoning once state externalized to files: −25.5% input tokens.
- Shipping: Claude Code fixed prefix order (system+tools → CLAUDE.md/memory → conversation), deferred tool schemas, compaction over warm cache, re-reads ≤5 recent files + re-injects skills after compaction, `SessionStart(compact)` hook, `/rewind` to cached prefix. Codex `model_auto_compact_token_limit`, server-side `/responses/compact` (opaque items). OpenCode prunes tool outputs beyond last 40k tokens then compacts.

Survives evidence: mask/offload old tool outputs first (disk + handle); LLM summary second stage at milestones; never compress recent turns; raw observations recoverable; cache-stable prefix; filter tool schemas; judge compressors by downstream solve rate and variance.

## C. Durable execution

- Temporal: server required; OpenAI Agents SDK integration (2026-03); sandbox sessions pause/snapshot/fork (2026-04). Restate: single Rust binary, embedded RocksDB. DBOS Transact: in-process, Postgres or SQLite (Go SQLite 2026-06; TS [U]). LangGraph `SqliteSaver`. Mastra LibSQL snapshots. Cloudflare Project Think (2026-04-15): agent = Durable Object + SQLite, tree sessions with fork + compaction. DeltaBox sandbox checkpoint 14ms / rollback 5ms (2605.22781). "When can agents safely checkpoint/fork/restore/merge" (2608.22928).
- No mature OSS project combines task-DAG + checkpoint + verification for coding agents. Gap is real. (Pi's Pico5 spec targets part of it; see pi-herdr brief.)

## D. Code intelligence

- Claude Code built-in LSP tool since v2.0.74, plugins for 11 languages, diagnostics after edits, no code graph. OpenCode LSP + tree-sitter, diagnostics after every edit. Codex: none found [U]. Cursor: grep index. Serena MCP: LSP-backed symbol tools.
- SWE-Explore (2606.07297): agents reach ~65% of files but only 15–19% line recall; context efficiency r=0.95 with repair success; oracle context → 59.7% resolve. "Code Isn't Memory" (2606.22417): structural index inside agent gives localization + resolve gain at no cost penalty. RepoAtlas (2609.16936): +2.4pp SWE-bench Verified, −5.8% tokens. RepoNav (2609.08355).

## E. Multi-agent

- Scaling Agent Systems (2512.08296, rev 2026-04): +80.8% on decomposable financial reasoning, −70% on sequential planning; diminishing returns once single agent strong; no central verifier → error propagation. Single-agent > MAS at equal thinking budget (2604.02460): 0.418 vs 0.379. Strong single-agent baseline (2601.12307). Skills phase transition (2601.04748): semantic confusability, not count, breaks routing.
- Bottom line: single agent default; parallel workers only for independent, test-verifiable units with central verifier; subagents for context isolation, not role-play.

## Ranked: implement first

1. Verification gate before "done".
2. Cache-stable prompt layout + deferred tool schemas + dynamic content last.
3. Observation masking/offload before any LLM summary.
4. Externalized state: progress file + feature list + git commits; fresh context per unit.
5. Milestone-triggered recoverable compaction with re-injection of key files.
6. LSP/structural index for localization.
7. Enforcement in code: linters/hooks with self-correcting messages.
8. Small instruction map + on-demand skills/docs.
9. Loop detection + step budgets; planning only for weak models.
10. Behavioral eval suite with traces; single-agent default with verified parallel fan-out.
