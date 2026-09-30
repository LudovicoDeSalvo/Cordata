import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveRepo, sha256 } from './git.ts';
import { bashCommand, closeOpen, markUnknown, mentionsCordata, recordTool, type ToolEvent } from './journal.ts';
import { projection } from './projection.ts';
import { event, logBypass, openStore, type DB } from './store.ts';
import { addTamper, attach, attachedTask, openTask, type Task } from './task.ts';
import { stopGate } from './verify.ts';

/** Claude Code hook stdin; only the fields Cordata reads. */
export type HookInput = Partial<ToolEvent> & {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  file_path?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  background_tasks?: unknown[];
};

const TOOL_PHASE = { PreToolUse: 'pre', PostToolUse: 'post', PostToolUseFailure: 'failure' } as const;

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
    const context = (hookEventName: string, t: Task) => ({
      hookSpecificOutput: { hookEventName, additionalContext: projection(db!, t, hostWarnings(db!, t, sessionId)) },
    });

    if (eventName === 'SessionStart') {
      task = openTask(db, repo.root);
      if (!task) return {};
      attach(db, task.id, { sessionId, transcriptPath: input.transcript_path, source: input.source ?? 'startup' });
      markUnknown(db, task.id, sessionId, input.source === 'resume');
      return context('SessionStart', task);
    }
    task = attachedTask(db, sessionId, repo.root);
    if (eventName === 'UserPromptSubmit' && !task) {
      // D-024: a session that started before `cordata confirm` attaches on its next prompt, with the projection once
      task = openTask(db, repo.root);
      if (!task) return {};
      attach(db, task.id, { sessionId, transcriptPath: input.transcript_path, source: 'prompt' });
      return context('UserPromptSubmit', task);
    }
    if (!task) return {}; // invariant 7: no attached task, nothing recorded
    db.prepare('UPDATE session SET last_seen_at = ? WHERE host_session_id = ? AND task_id = ?').run(Date.now(), sessionId, task.id);

    switch (eventName) {
      case 'UserPromptSubmit':
        closeOpen(db, sessionId);
        return {};
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const ev = { ...input, session_id: sessionId };
        recordTool(db, task.id, TOOL_PHASE[eventName], ev);
        const cmd = bashCommand(input.tool_input);
        if (eventName === 'PreToolUse' && cmd && mentionsCordata(cmd)) addTamper(db, task, [{ path: `bash: ${cmd.slice(0, 120)}`, blob: sha256(cmd).slice(0, 16) }], null);
        return {}; // async hook: stdout would reach Claude on the next turn
      }
      case 'ConfigChange': {
        const file = input.file_path;
        const settings = file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8') || '{}') as Settings) : {};
        if (!hooksIntact(settings, input.source === 'user_settings'))
          addTamper(db, task, [{ path: `settings: ${file ?? input.source}`, blob: sha256(JSON.stringify(settings)).slice(0, 16) }], null);
        return {};
      }
      case 'Stop': {
        closeOpen(db, sessionId);
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

type Settings = { hooks?: Record<string, Group[]>; disableAllHooks?: boolean; sandbox?: { enabled?: boolean } };

/** D-020: a settings change that disables hooks, or drops Cordata's Stop hook from the user settings, is tamper evidence. */
export function hooksIntact(s: Settings, isUserSettings: boolean): boolean {
  if (s.disableAllHooks === true) return false;
  return !isUserSettings || !!s.hooks?.Stop?.some((g) => g.hooks.some(isCordata));
}

const readJson = (file: string): Settings => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Settings;
  } catch {
    return {};
  }
};
const settingsFiles = (root: string) => [
  join(homedir(), '.claude', 'settings.json'),
  join(root, '.claude', 'settings.json'),
  join(root, '.claude', 'settings.local.json'),
];

/** Warnings only the host side knows: sandbox (D-019) and other sessions on the task (D-018). */
export function hostWarnings(db: DB, task: Task, sessionId?: string): string[] {
  const w: string[] = [];
  if (settingsFiles(task.worktree_path).some((f) => readJson(f).sandbox?.enabled === true))
    w.push('Claude Code sandbox is enabled, but Cordata verifiers run outside the sandbox (D-019)');
  if (sessionId === undefined) return w; // `cordata status` lists sessions itself
  const others = db
    .prepare('SELECT host_session_id FROM session WHERE task_id = ? AND host_session_id != ? AND last_seen_at > ?')
    .all(task.id, sessionId, Date.now() - 30 * 60_000) as { host_session_id: string }[];
  if (others.length) w.push(`another session was active on this task in the last 30 min: ${others.map((o) => o.host_session_id).join(', ')}`);
  return w;
}

/** For `cordata status`: installed hooks whose node or cli path vanished (e.g. an nvm upgrade) fail before Cordata runs. */
export function hookProblems(settingsPath = join(homedir(), '.claude', 'settings.json')): string[] {
  const entries = Object.values(readJson(settingsPath).hooks ?? {}).flatMap((gs) => gs.flatMap((g) => g.hooks.filter(isCordata)));
  if (!entries.length) return [`no Cordata hooks in ${settingsPath}; run \`cordata install\``];
  const missing = new Set(entries.flatMap((h) => [h.command!, h.args![0]!]).filter((p) => !existsSync(p)));
  return missing.size ? [`installed Cordata hooks point at missing paths: ${[...missing].join(', ')}; run \`cordata install\` again`] : [];
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
