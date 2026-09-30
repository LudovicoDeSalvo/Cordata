import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { branch, pinRef, writeTree, type Repo } from './git.ts';
import { CONFIG, event, tx, type DB } from './store.ts';
import { blockReason } from './projection.ts';
import { frozen, getTask, units, type Task, type Unit } from './task.ts';

export type Verdict = 'PASS' | 'FAIL' | 'ERROR';
export type UnitResult = {
  unit_id: string;
  status: Verdict;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
  duration_ms: number;
  stdout: string;
  stderr: string;
};
export type Run = {
  id: number;
  task_id: string;
  trigger: 'STOP' | 'CLI' | 'TICK';
  host_session_id: string | null;
  spec_version: string;
  tree_hash: string;
  tree_after: string | null;
  ref: string | null;
  lease_pid: number | null;
  started_at: number;
  ended_at: number | null;
  verdict: Verdict | null;
  note: string | null;
  warnings: string | null; // JSON string[]
  tamper: string | null;
};
export type RunOutcome = { run: Run; reused: boolean; results: UnitResult[] };

const HEAD = 8 * 1024;
const TAIL = 56 * 1024;

/** First 8 KB + rolling last 56 KB of a stream (D-025). */
function capture() {
  let head = Buffer.alloc(0);
  const tail: Buffer[] = [];
  let tailLen = 0;
  let total = 0;
  return {
    push(b: Buffer) {
      total += b.length;
      if (head.length < HEAD) {
        const take = b.subarray(0, HEAD - head.length);
        head = Buffer.concat([head, take]);
        b = b.subarray(take.length);
      }
      if (!b.length) return;
      tail.push(b);
      tailLen += b.length;
      while (tailLen - tail[0]!.length >= TAIL) tailLen -= tail.shift()!.length;
    },
    text() {
      let t = Buffer.concat(tail);
      if (t.length > TAIL) t = t.subarray(t.length - TAIL);
      const dropped = total - head.length - t.length;
      return head.toString() + (dropped > 0 ? `\n…[${dropped} bytes truncated]…\n` : '') + t.toString();
    },
  };
}

// The unit currently running in this process, so a signal handler can kill its group and close the run.
let current: { pgid?: number; db: DB; runId: number } | null = null;

export function abortCurrent(): void {
  if (!current) return;
  if (current.pgid) killGroup(current.pgid, 'SIGKILL');
  try {
    current.db.prepare("UPDATE run SET ended_at = ?, note = 'aborted by signal' WHERE id = ? AND ended_at IS NULL").run(Date.now(), current.runId);
  } catch {
    // the lease goes stale on its own (dead pid)
  }
  current = null;
}

function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // ESRCH: group already gone
  }
}

type RunnableUnit = Pick<Unit, 'id' | 'command' | 'cwd' | 'timeout_ms'>;

/** Runs one EXEC unit in its own process group (D-018 verdicts: 0 PASS, other exit FAIL, 126/127/timeout/spawn ERROR). */
export function runUnit(u: RunnableUnit, root: string, deadline: number): Promise<UnitResult> {
  const start = Date.now();
  const result = (status: Verdict, rest: Partial<UnitResult>): UnitResult => ({
    unit_id: u.id, status, exit_code: null, signal: null, error: null, duration_ms: Date.now() - start, stdout: '', stderr: '', ...rest,
  });
  const limit = Math.min(u.timeout_ms ?? Infinity, deadline - start);
  if (limit <= 0) return Promise.resolve(result('ERROR', { error: 'verification budget exhausted; not started' }));
  const cwd = resolve(root, u.cwd ?? '.');
  if (!existsSync(cwd)) return Promise.resolve(result('ERROR', { error: `cwd not found: ${cwd}` }));

  return new Promise((done) => {
    // bash, not sh: commands are tried in Claude's Bash tool, and /bin/sh is dash on Ubuntu. stdin ignored so prompts get EOF.
    const child = spawn(u.command!, { cwd, shell: '/bin/bash', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (current) current.pgid = child.pid;
    const out = capture();
    const err = capture();
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    let timedOut = false;
    let finished = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid!, 'SIGTERM');
      setTimeout(() => killGroup(child.pid!, 'SIGKILL'), 5000).unref();
    }, limit);
    const finish = (r: UnitResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (child.pid) killGroup(child.pid, 'SIGKILL'); // leave no stray servers or watchers behind
      if (current) current.pgid = undefined;
      done(r);
    };
    child.on('error', (e) => {
      if (child.pid === undefined) finish(result('ERROR', { error: `spawn failed: ${e.message}` }));
    });
    child.on('exit', (code, signal) => {
      const settle = () => {
        const io = { exit_code: code, signal, stdout: out.text(), stderr: err.text() };
        if (timedOut) finish(result('ERROR', { ...io, error: `timed out after ${limit} ms` }));
        else if (code === 126 || code === 127) finish(result('ERROR', { ...io, error: `exit ${code}: command not found or not executable` }));
        else finish(result(code === 0 ? 'PASS' : 'FAIL', io));
      };
      // a grandchild may hold the pipes open; wait briefly for them, then stop reading
      const wait = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle();
      }, 2000);
      child.once('close', () => {
        clearTimeout(wait);
        settle();
      });
    });
  });
}

function lastFinished(db: DB, task: Task): Run | undefined {
  return db
    .prepare('SELECT * FROM run WHERE task_id = ? AND spec_version = ? AND verdict IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get(task.id, task.spec_version) as Run | undefined;
}

export function runResults(db: DB, runId: number): UnitResult[] {
  return db.prepare('SELECT * FROM unit_result WHERE run_id = ?').all(runId) as UnitResult[];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The one path that writes PASS/FAIL (invariant 1): snapshot, run every EXEC unit, snapshot again, record.
 * An unchanged (tree, spec version) reuses the last finished run (D-015); one run per task at a time (D-018).
 */
export async function verify(
  db: DB,
  repo: Repo,
  task: Task,
  o: { trigger: Run['trigger']; sessionId?: string; deadline: number; force?: boolean },
): Promise<RunOutcome> {
  const root = task.worktree_path;
  let runId: number;
  let tree: string;
  for (;;) {
    tree = writeTree(root);
    const last = lastFinished(db, task);
    if (!o.force && last?.tree_hash === tree) return { run: last, reused: true, results: runResults(db, last.id) };
    try {
      runId = Number(
        db
          .prepare(
            `INSERT INTO run(task_id, trigger, host_session_id, spec_version, tree_hash, lease_pid, started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(task.id, o.trigger, o.sessionId ?? null, task.spec_version, tree, process.pid, Date.now()).lastInsertRowid,
      );
      break;
    } catch (e) {
      if (!String(e).includes('UNIQUE constraint failed')) throw e;
    }
    const holder = db.prepare('SELECT * FROM run WHERE task_id = ? AND ended_at IS NULL').get(task.id) as Run | undefined;
    if (holder && (!alive(holder.lease_pid!) || holder.started_at < Date.now() - CONFIG.staleLeaseMs)) {
      db.prepare("UPDATE run SET ended_at = ?, note = 'stale lease' WHERE id = ? AND ended_at IS NULL").run(Date.now(), holder.id);
      continue;
    }
    if (Date.now() + 500 > o.deadline) throw new Error(`another verification of ${task.id} held the lease past the budget`);
    await sleep(500);
  }

  current = { db, runId };
  try {
    const ref = `refs/cordata/${task.id}/${runId}`;
    pinRef(root, ref, tree);
    db.prepare('UPDATE run SET ref = ? WHERE id = ?').run(ref, runId);
    const warnings: string[] = [];
    const head = branch(root);
    if (head !== task.branch_at_creation)
      warnings.push(`HEAD is on ${head ?? 'a detached commit'}; the task was created on ${task.branch_at_creation ?? 'a detached commit'}`);

    const results: UnitResult[] = [];
    for (const u of units(db, task.id)) if (u.origin === 'SPEC' && u.kind === 'EXEC') results.push(await runUnit(u, root, o.deadline));
    const after = writeTree(root);
    let note: string | null = null;
    let verdict: Verdict;
    if (after !== tree) {
      verdict = 'ERROR';
      note = 'worktree changed during verification (verifiers must not write tracked or untracked non-ignored files)';
    } else verdict = results.some((r) => r.status === 'FAIL') ? 'FAIL' : results.some((r) => r.status === 'ERROR') ? 'ERROR' : 'PASS';

    record(db, task, runId, { verdict, tree, after, note, warnings, results });
    return { run: db.prepare('SELECT * FROM run WHERE id = ?').get(runId) as Run, reused: false, results };
  } finally {
    db.prepare("UPDATE run SET ended_at = ?, note = coalesce(note, 'aborted') WHERE id = ? AND ended_at IS NULL").run(Date.now(), runId);
    current = null;
  }
}

function record(
  db: DB,
  task: Task,
  runId: number,
  r: { verdict: Verdict; tree: string; after: string; note: string | null; warnings: string[]; results: UnitResult[] },
): void {
  const now = Date.now();
  tx(db, () => {
    db.prepare('UPDATE run SET verdict = ?, tree_after = ?, ended_at = ?, note = ?, warnings = ? WHERE id = ?').run(
      r.verdict, r.after, now, r.note, JSON.stringify(r.warnings), runId,
    );
    const ins = db.prepare(
      `INSERT INTO unit_result(run_id, unit_id, status, exit_code, signal, error, duration_ms, stdout, stderr)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const upd = db.prepare('UPDATE unit SET status = ?, last_run_id = ? WHERE task_id = ? AND id = ?');
    for (const u of r.results) {
      ins.run(runId, u.unit_id, u.status, u.exit_code, u.signal, u.error, u.duration_ms, u.stdout, u.stderr);
      upd.run(u.status, runId, task.id, u.unit_id);
    }
    const fresh = getTask(db, task.id)!;
    if (fresh.status !== 'ACTIVE' && fresh.status !== 'VERIFIED_PENDING_MANUAL') return;
    let status: Task['status'] = 'ACTIVE';
    if (r.verdict === 'PASS') {
      const { n } = db
        .prepare("SELECT count(*) AS n FROM unit WHERE task_id = ? AND kind = 'MANUAL' AND status != 'TICKED'")
        .get(task.id) as { n: number };
      status = n ? 'VERIFIED_PENDING_MANUAL' : 'DONE';
    }
    db.prepare(
      `UPDATE task SET status = ?, last_pass_tree = CASE WHEN ? = 'PASS' THEN ? ELSE last_pass_tree END,
       closed_at = CASE WHEN ? = 'DONE' THEN ? ELSE closed_at END, updated_at = ? WHERE id = ?`,
    ).run(status, r.verdict, r.tree, status, now, now, task.id);
    event(db, task.id, `RUN_${r.verdict}`, { runId, status });
  });
}

export type StopEvent = { sessionId: string; message: string; background: boolean; continuing: boolean };
export type GateResult = { block?: string; message?: string; run?: RunOutcome };

/** D-015/D-018 Stop gate. Throws only on internal failure; the caller records GATE_BYPASS and allows. */
export async function stopGate(db: DB, repo: Repo, task: Task, ev: StopEvent, deadline: number): Promise<GateResult> {
  if (task.status !== 'ACTIVE') return {};
  const sess = { id: ev.sessionId, task: task.id };
  if (!ev.continuing)
    db.prepare('UPDATE session SET fail_count = 0, error_blocked = 0 WHERE host_session_id = ? AND task_id = ?').run(sess.id, sess.task);
  if (ev.background || !ev.message.includes(CONFIG.marker)) return {};

  const r = await verify(db, repo, task, { trigger: 'STOP', sessionId: ev.sessionId, deadline });
  const { run } = r;
  if (r.reused) return { run: r, message: `Cordata: tree unchanged since run #${run.id} (${run.verdict}); not re-run.` };
  if (run.verdict === 'PASS') {
    const t = getTask(db, task.id)!;
    return { run: r, message: `Cordata run #${run.id} PASS: task ${t.id} ${t.status === 'DONE' ? 'DONE' : 'verified; manual units pending (`cordata status`)'}` };
  }
  const s = db.prepare('SELECT fail_count, error_blocked FROM session WHERE host_session_id = ? AND task_id = ?').get(sess.id, sess.task) as
    | { fail_count: number; error_blocked: number }
    | undefined;
  if (run.verdict === 'FAIL') {
    const n = (s?.fail_count ?? 0) + 1;
    db.prepare('UPDATE session SET fail_count = ? WHERE host_session_id = ? AND task_id = ?').run(n, sess.id, sess.task);
    if (n > frozen(task).failCap) {
      event(db, task.id, 'FAIL_CAP_ALLOW', { runId: run.id, session: ev.sessionId });
      return { run: r, message: `Cordata run #${run.id} FAIL; stop allowed after ${n - 1} blocked claims in a row. Task stays ACTIVE.` };
    }
    return { run: r, block: blockReason(db, task, r) };
  }
  if (!s?.error_blocked) {
    db.prepare('UPDATE session SET error_blocked = 1 WHERE host_session_id = ? AND task_id = ?').run(sess.id, sess.task);
    return { run: r, block: blockReason(db, task, r) };
  }
  event(db, task.id, 'ERROR_ALLOW', { runId: run.id, session: ev.sessionId });
  return { run: r, message: `Cordata run #${run.id} ERROR again; stop allowed. Task stays ACTIVE.` };
}
