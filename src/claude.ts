import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveRepo } from './git.ts';
import { projection } from './projection.ts';
import { event, logBypass, openStore, type DB } from './store.ts';
import { attach, attachedTask, openTask, type Task } from './task.ts';
import { stopGate } from './verify.ts';

/** Claude Code hook stdin; only the fields Cordata reads. */
export type HookInput = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  background_tasks?: unknown[];
};

/** Handles one hook event and returns the JSON to print. Never throws: failures are recorded and allowed (D-018). */
export async function runHook(eventName: string, input: HookInput, deadline: number): Promise<object> {
  let db: DB | null = null;
  let task: Task | undefined;
  try {
    const repo = resolveRepo(input.cwd ?? process.cwd());
    if (!repo || !input.session_id) return {};
    db = openStore(repo.projectId, false);
    if (!db) return {};
    const sessionId = input.session_id;
    switch (eventName) {
      case 'SessionStart': {
        task = openTask(db, repo.root);
        if (!task) return {};
        attach(db, task.id, { sessionId, transcriptPath: input.transcript_path, source: input.source ?? 'startup' });
        return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: projection(db, task) } };
      }
      case 'Stop': {
        task = attachedTask(db, sessionId, repo.root);
        if (!task) return {};
        db.prepare('UPDATE session SET last_seen_at = ? WHERE host_session_id = ? AND task_id = ?').run(Date.now(), sessionId, task.id);
        const g = await stopGate(
          db,
          repo,
          task,
          {
            sessionId,
            message: input.last_assistant_message ?? '',
            background: (input.background_tasks?.length ?? 0) > 0,
            continuing: input.stop_hook_active === true,
          },
          deadline,
        );
        if (g.block) return { decision: 'block', reason: g.block };
        return g.message ? { systemMessage: g.message } : {};
      }
      default:
        return {};
    }
  } catch (e) {
    const payload = { hook: eventName, session: input.session_id, error: String((e as Error)?.stack ?? e).slice(0, 2000) };
    try {
      if (!db) throw e;
      event(db, task?.id ?? null, eventName === 'Stop' ? 'GATE_BYPASS' : 'HOOK_ERROR', payload);
    } catch {
      logBypass({ task: task?.id, ...payload });
    }
    return {};
  } finally {
    db?.close();
  }
}

type HookEntry = { type: string; command?: string; args?: string[]; timeout?: number; async?: boolean };
type Group = { matcher?: string; hooks: HookEntry[] };

const JOURNAL = 'Bash|Edit|Write|NotebookEdit|mcp__.*';
// All events are installed once; ones not handled yet return {} (D-022: install once, inert without a task).
const EVENTS: [string, string | undefined, Partial<HookEntry>][] = [
  ['SessionStart', undefined, {}],
  ['UserPromptSubmit', undefined, {}],
  ['Stop', undefined, { timeout: 1800 }], // D-018: budget = timeout − 60 s
  ['PreToolUse', JOURNAL, { async: true }],
  ['PostToolUse', JOURNAL, { async: true }],
  ['PostToolUseFailure', JOURNAL, { async: true }],
  ['ConfigChange', undefined, { async: true }],
];

const isCordata = (h: HookEntry) => !!h.args?.[0]?.endsWith('/src/cli.ts') && h.args[1] === 'hook';

/** Merges Cordata's exec-form hooks into a settings file, keeping everything else. Idempotent. */
export function installHooks(settingsPath: string, cliPath: string): { changed: boolean; backup?: string } {
  const before = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '';
  const settings = (before.trim() ? JSON.parse(before) : {}) as { hooks?: Record<string, Group[]> };
  const hooks = (settings.hooks ??= {});
  for (const [name, matcher, extra] of EVENTS) {
    const groups = (hooks[name] ?? [])
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isCordata(h)) }))
      .filter((g) => g.hooks.length);
    const entry: HookEntry = { type: 'command', command: process.execPath, args: [cliPath, 'hook', name], ...extra };
    groups.push(matcher ? { matcher, hooks: [entry] } : { hooks: [entry] });
    hooks[name] = groups;
  }
  const after = JSON.stringify(settings, null, 2) + '\n';
  if (after === before) return { changed: false };
  let backup: string | undefined;
  if (before) {
    backup = `${settingsPath}.cordata-backup-${Date.now()}`;
    copyFileSync(settingsPath, backup);
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, after);
  return { changed: true, backup };
}
