import { homedir } from 'node:os';
import { sha256 } from './git.ts';
import type { DB } from './store.ts';

export type EffectClass = 'READ' | 'LOCAL_WRITE' | 'REMOTE_WRITE' | 'DESTRUCTIVE';
export type ToolEvent = {
  session_id: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_response?: unknown;
  error?: string;
};

// ponytail: regex heuristics, labelled "heuristic" wherever shown; a shell parser if misclassification bites.
const DESTRUCTIVE = /\brm\s+-\w*[rf]|\bgit\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+(--\s|\.)|restore\b|branch\s+-D|push\b.*\s(--force|-f)\b)|\bdd\s+if=|\bmkfs\b|\bdrop\s+(table|database)\b/i;
const REMOTE =
  /\bgit\s+push\b|\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+\w+\s+(create|merge|close|edit|delete|comment|review)\b|\bcurl\b.*(-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s)|\b(docker|podman)\s+push\b|\bkubectl\s+(apply|delete|create)\b|\bterraform\s+(apply|destroy)\b|\bscp\b|\brsync\b/i;
const READ_CMD = /^\s*(ls|cat|head|tail|grep|rg|find|fd|pwd|echo|wc|which|file|stat|tree|du|df|env|printenv|git\s+(status|log|diff|show|branch|rev-parse|ls-files|blame)|node\s+--version|npm\s+(ls|view|outdated))\b/;

export function classify(tool: string, input: unknown): EffectClass {
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return 'LOCAL_WRITE';
  if (tool.startsWith('mcp__')) return 'REMOTE_WRITE';
  const cmd = bashCommand(input);
  if (cmd === null) return 'LOCAL_WRITE';
  if (DESTRUCTIVE.test(cmd)) return 'DESTRUCTIVE';
  if (REMOTE.test(cmd)) return 'REMOTE_WRITE';
  if (READ_CMD.test(cmd) && !/[>]|\|\s*(tee|sh|bash|xargs)\b|;|&&/.test(cmd)) return 'READ';
  return 'LOCAL_WRITE';
}

export function bashCommand(input: unknown): string | null {
  const c = (input as { command?: unknown } | null)?.command;
  return typeof c === 'string' ? c : null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A Bash command touching user-only verbs or Cordata's state adds tamper evidence (D-016). Specs under .cordata/ do not. */
export function mentionsCordata(cmd: string): boolean {
  const home = `(?:~|\\$HOME|\\$\\{HOME\\}|${esc(homedir())})/\\.cordata\\b`;
  return new RegExp(`\\bcordata\\s+(confirm|tick|done|abandon)\\b|cordata\\.sqlite|${home}|CORDATA_HOME`).test(cmd);
}

const clip = (s: string, n = 2048) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Upserts by tool_use_id: async hooks arrive in any order, so Pre never overwrites an outcome and Post always does. */
export function recordTool(db: DB, taskId: string, phase: 'pre' | 'post' | 'failure', ev: ToolEvent): void {
  if (!ev.tool_use_id || !ev.tool_name) return;
  const input = JSON.stringify(ev.tool_input ?? null);
  const excerpt = clip(bashCommand(ev.tool_input) ?? input);
  const cls = classify(ev.tool_name, ev.tool_input);
  const now = Date.now();
  if (phase === 'pre') {
    db.prepare(
      `INSERT INTO action(tool_use_id, task_id, host_session_id, tool, input_hash, input_excerpt, effect_class, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tool_use_id) DO UPDATE SET started_at = coalesce(action.started_at, excluded.started_at)`,
    ).run(ev.tool_use_id, taskId, ev.session_id, ev.tool_name, sha256(input).slice(0, 16), excerpt, cls, now);
    return;
  }
  const outcome = phase === 'post' ? 'OK' : 'ERROR';
  const output = clip(phase === 'post' ? (typeof ev.tool_response === 'string' ? ev.tool_response : JSON.stringify(ev.tool_response ?? null)) : (ev.error ?? ''));
  db.prepare(
    `INSERT INTO action(tool_use_id, task_id, host_session_id, tool, input_hash, input_excerpt, effect_class, ended_at, outcome, output_excerpt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool_use_id) DO UPDATE SET ended_at = excluded.ended_at, outcome = excluded.outcome, output_excerpt = excluded.output_excerpt`,
  ).run(ev.tool_use_id, taskId, ev.session_id, ev.tool_name, sha256(input).slice(0, 16), excerpt, cls, now, outcome, output);
}

/** At a session's next Stop or prompt, its still-open calls were denied or interrupted (D-017). */
export function closeOpen(db: DB, sessionId: string): void {
  db.prepare("UPDATE action SET outcome = 'NO_RESULT', ended_at = ? WHERE host_session_id = ? AND outcome IS NULL").run(Date.now(), sessionId);
}

/**
 * Calls left open by sessions that never reached a Stop or prompt: outcome unknown. On `resume` the session id is
 * reused, so its own open calls count too. A late Post still overwrites this.
 */
export function markUnknown(db: DB, taskId: string, sessionId: string, includeOwn: boolean): void {
  db.prepare(`UPDATE action SET outcome = 'UNKNOWN' WHERE task_id = ? AND outcome IS NULL ${includeOwn ? '' : 'AND host_session_id != ?'}`).run(
    ...(includeOwn ? [taskId] : [taskId, sessionId]),
  );
}
