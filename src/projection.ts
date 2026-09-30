import { existsSync, readFileSync } from 'node:fs';
import { parseSpec, type UnitSpec } from './spec.ts';
import { CONFIG, type DB } from './store.ts';
import { confirmedPart, units, type Task, type Unit } from './task.ts';
import { runResults, type Run, type RunOutcome, type UnitResult } from './verify.ts';

// Trim order when over the cap (D-023): shrink excerpts first, then collapse lists.
const LEVELS = [
  { head: 3, tail: 15, list: Infinity },
  { head: 2, tail: 6, list: Infinity },
  { head: 1, tail: 2, list: Infinity },
  { head: 0, tail: 0, list: Infinity },
  { head: 0, tail: 0, list: 10 },
  { head: 0, tail: 0, list: 3 },
];
type Level = (typeof LEVELS)[number];
const FOOTER = 'full state: `cordata status`';

/** Picks the most detailed rendering that fits; always ends with the footer. */
export function fitCap(render: (l: Level) => string, max: number = CONFIG.cap): string {
  let text = '';
  for (const l of LEVELS) {
    text = render(l);
    if (text.length + FOOTER.length + 1 <= max) return `${text}\n${FOOTER}`;
  }
  return `${text.slice(0, max - FOOTER.length - 3)}…\n${FOOTER}`;
}

function excerpt(text: string, head: number, tail: number): string[] {
  if (head + tail === 0 || !text.trim()) return [];
  const lines = text.trimEnd().split('\n').map((l) => (l.length > 300 ? l.slice(0, 300) + '…' : l));
  if (lines.length <= head + tail) return lines;
  return [...lines.slice(0, head), `… (${lines.length - head - tail} lines omitted)`, ...lines.slice(-tail)];
}

function collapse(items: string[], n: number): string[] {
  return items.length <= n ? items : [...items.slice(0, n), `+${items.length - n} more`];
}

const short = (h: string | null) => (h ? h.slice(0, 7) : '-');
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

function unitLine(u: Unit): string {
  const who = u.kind === 'MANUAL' && u.status !== 'TICKED' ? ' (ticked by the user)' : '';
  return `- ${u.id} ${u.kind} ${u.status}${who}: ${u.description}${u.command ? ` — \`${u.command}\`` : ''}`;
}

function failureLines(results: UnitResult[], cmds: Map<string, string | null>, l: Level): string[] {
  const out: string[] = [];
  for (const r of results.filter((x) => x.status !== 'PASS')) {
    const how = r.error ?? (r.signal ? `killed by ${r.signal}` : `exit ${r.exit_code}`);
    out.push(`- ${r.unit_id} \`${cmds.get(r.unit_id) ?? ''}\` ${r.status}: ${how} after ${(r.duration_ms / 1000).toFixed(1)} s`);
    const body = r.stderr.trim() ? r.stderr : r.stdout; // node:test, pytest and go test report failures on stdout
    out.push(...excerpt(body, l.head, l.tail).map((x) => `    ${x}`));
  }
  return out;
}

function lastRun(db: DB, task: Task): Run | undefined {
  return db
    .prepare('SELECT * FROM run WHERE task_id = ? AND verdict IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get(task.id) as Run | undefined;
}

/** What differs between the spec file and the confirmed version (D-021). */
export function drift(task: Task): string | null {
  if (!task.confirmed_spec) return null;
  if (!existsSync(task.spec_path)) return `the spec file ${task.spec_path} is missing; the gate uses the confirmed version`;
  let parts: ReturnType<typeof confirmedPart>;
  try {
    parts = confirmedPart(parseSpec(readFileSync(task.spec_path, 'utf8')));
  } catch (e) {
    return `the spec file no longer parses (${(e as Error).message.split('\n')[1] ?? 'invalid'}); the gate uses the confirmed version`;
  }
  const confirmed = JSON.parse(task.confirmed_spec) as { units: UnitSpec[]; goal: string; constraints: string };
  const changed = (['units', 'goal', 'constraints'] as const).filter((k) => JSON.stringify(parts[k]) !== JSON.stringify(confirmed[k]));
  if (!changed.length) return null;
  return `the spec file's ${changed.join(', ')} differ from the confirmed version; the gate uses the confirmed version until the user runs \`cordata confirm\``;
}

function warnings(task: Task, run: Run | undefined): string[] {
  const w: string[] = [];
  const d = drift(task);
  if (d) w.push(d);
  if (run?.warnings) w.push(...(JSON.parse(run.warnings) as string[]));
  return w;
}

function body(db: DB, task: Task, l: Level): string[] {
  const spec = JSON.parse(task.confirmed_spec!) as { goal: string; constraints: string };
  const us = units(db, task.id);
  const run = lastRun(db, task);
  const lines = [
    `Cordata task ${task.id} "${task.title}" is ${task.status} in this worktree (spec version ${task.spec_version}).`,
    `Goal:\n${spec.goal}`,
  ];
  if (spec.constraints) lines.push(`Constraints:\n${spec.constraints}`);
  lines.push('Acceptance units:', ...collapse(us.map(unitLine), l.list));
  if (run) {
    lines.push(`Last verification: run #${run.id} ${run.verdict} on tree ${short(run.tree_hash)} at ${when(run.started_at)} (${run.trigger}).`);
    if (run.note) lines.push(`  ${run.note}`);
    const cmds = new Map(us.map((u) => [u.id, u.command]));
    lines.push(...collapse(failureLines(runResults(db, run.id), cmds, l), l.list === Infinity ? Infinity : l.list * 2));
  } else lines.push('No verification run yet.');
  const w = warnings(task, run);
  if (w.length) lines.push('Notes:', ...collapse(w.map((x) => `- ${x}`), l.list));
  return lines;
}

const COMPLETION =
  `Completion is verified only when a final message contains ${CONFIG.marker}: Cordata then runs the EXEC units on a ` +
  'snapshot of the worktree, and a failure keeps the session going with the evidence. A claim on an unchanged tree reuses the last result.';

/** SessionStart / attach context, capped (D-023). Factual wording, no system-style commands. */
export function projection(db: DB, task: Task): string {
  return fitCap((l) => [...body(db, task, l), COMPLETION].join('\n'));
}

export function blockReason(db: DB, task: Task, r: RunOutcome): string {
  const { run, results } = r;
  const cmds = new Map(units(db, task.id).map((u) => [u.id, u.command]));
  return fitCap((l) => {
    const lines = [
      `${run.verdict === 'ERROR' ? '[infrastructure error] ' : ''}Cordata verification run #${run.id} ${run.verdict} ` +
        `(tree ${short(run.tree_hash)}, spec version ${run.spec_version}).`,
    ];
    if (run.note) lines.push(run.note);
    if (run.verdict === 'ERROR')
      lines.push('ERROR means the check could not run cleanly (command not found, timeout, or the worktree changed), not a test failure. A second ERROR in this chain allows the stop.');
    lines.push('Units not passing:', ...collapse(failureLines(results, cmds, l), l.list === Infinity ? Infinity : l.list * 2));
    const w = run.warnings ? (JSON.parse(run.warnings) as string[]) : [];
    if (w.length) lines.push('Notes:', ...collapse(w.map((x) => `- ${x}`), l.list));
    lines.push(`The task stays ACTIVE. The next verification runs when a final message contains ${CONFIG.marker} and the worktree differs from tree ${short(run.tree_hash)}.`);
    return lines.join('\n');
  });
}

/** `cordata status`: uncapped, with runs, snapshot refs and resumable sessions. */
export function statusText(db: DB, root: string, task?: Task): string {
  if (!task) {
    const rows = db.prepare('SELECT id, title, status FROM task WHERE worktree_path = ? ORDER BY created_at DESC LIMIT 10').all(root) as Pick<
      Task,
      'id' | 'title' | 'status'
    >[];
    return rows.length ? ['No open task here. Recent tasks:', ...rows.map((t) => `- ${t.id} ${t.status}: ${t.title}`)].join('\n') : 'No Cordata task in this worktree.';
  }
  if (task.status === 'DRAFT') return `Task ${task.id} "${task.title}" is DRAFT. Edit ${task.spec_path}, then run \`cordata confirm ${task.id}\` in your own terminal.`;
  const out = body(db, task, LEVELS[0]!);
  const runs = db.prepare('SELECT * FROM run WHERE task_id = ? ORDER BY id DESC LIMIT 10').all(task.id) as Run[];
  if (runs.length) {
    out.push('Runs (newest first; restore a snapshot with the printed command, it leaves the index untouched):');
    for (const r of runs)
      out.push(
        `- #${r.id} ${r.verdict ?? (r.ended_at ? 'ABORTED' : 'RUNNING')} ${r.trigger} ${when(r.started_at)} tree ${short(r.tree_hash)}` +
          (r.ref ? `  git restore --source=${r.tree_hash} --worktree -- .` : ''),
      );
  }
  out.push(`Start tree: ${short(task.start_tree)} (refs/cordata/${task.id}/start)`);
  const sessions = db
    .prepare('SELECT host_session_id, last_seen_at FROM session WHERE task_id = ? ORDER BY last_seen_at DESC LIMIT 3')
    .all(task.id) as { host_session_id: string; last_seen_at: number }[];
  if (sessions.length) out.push('Sessions (resume with `claude --resume <id>`):', ...sessions.map((s) => `- ${s.host_session_id} last seen ${when(s.last_seen_at)}`));
  const bypass = db.prepare("SELECT count(*) AS n FROM task_event WHERE task_id = ? AND type = 'GATE_BYPASS'").get(task.id) as { n: number };
  if (bypass.n) out.push(`Gate bypasses recorded: ${bypass.n} (see task_event).`);
  return out.join('\n');
}
