import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addExclude, branch, pinRef, writeTree, type Repo } from './git.ts';
import { loadRepoConfig, parseSpec, resolveScripts, skeleton, specVersion, type FrozenConfig, type Spec } from './spec.ts';
import { event, tx, type DB } from './store.ts';

export type TaskStatus = 'DRAFT' | 'ACTIVE' | 'VERIFIED_PENDING_MANUAL' | 'DONE' | 'ABANDONED';
export type Task = {
  id: string;
  worktree_path: string;
  branch_at_creation: string | null;
  title: string;
  spec_path: string;
  spec_version: string | null;
  confirmed_spec: string | null; // JSON {units, goal, constraints}
  frozen_config: string | null; // JSON FrozenConfig
  resolved_scripts: string | null; // JSON Scripts
  status: TaskStatus;
  start_tree: string;
  last_pass_tree: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
};
export type Unit = {
  task_id: string;
  id: string;
  ord: number;
  spec_version: string;
  origin: 'SPEC' | 'TAMPER';
  kind: 'EXEC' | 'MANUAL';
  description: string;
  command: string | null;
  cwd: string | null;
  timeout_ms: number | null;
  status: 'PENDING' | 'PASS' | 'FAIL' | 'ERROR' | 'TICKED';
  last_run_id: number | null;
  tick_tree: string | null;
  ticked_at: number | null;
};

const OPEN = "('ACTIVE','VERIFIED_PENDING_MANUAL')";

export function newTask(db: DB, repo: Repo, title: string): Task {
  addExclude(repo.root, '/.cordata/'); // before the snapshot, so specs never enter a tree (D-022)
  const startTree = writeTree(repo.root);
  const now = Date.now();
  const task = tx(db, () => {
    db.prepare('INSERT OR IGNORE INTO project(id, git_common_dir) VALUES (?, ?)').run(repo.projectId, repo.commonDir);
    const { n } = db.prepare("SELECT coalesce(max(CAST(substr(id, 3) AS INTEGER)), 0) + 1 AS n FROM task").get() as { n: number };
    const id = `t-${String(n).padStart(4, '0')}`;
    const specPath = join(repo.root, '.cordata', 'tasks', `${id}.md`);
    db.prepare(
      `INSERT INTO task(id, worktree_path, branch_at_creation, title, spec_path, status, start_tree, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)`,
    ).run(id, repo.root, branch(repo.root), title, specPath, startTree, now, now);
    event(db, id, 'CREATED', { title });
    return getTask(db, id)!;
  });
  pinRef(repo.root, `refs/cordata/${task.id}/start`, startTree); // pinned so gc keeps it (D-022)
  mkdirSync(join(repo.root, '.cordata', 'tasks'), { recursive: true });
  if (!existsSync(task.spec_path)) writeFileSync(task.spec_path, skeleton(task.id, title));
  return task;
}

/** Validates and freezes the spec file as the confirmed version; a new version resets spec unit statuses (D-021). */
export function confirmTask(db: DB, task: Task): { version: string; reset: boolean } {
  if (task.status === 'DONE' || task.status === 'ABANDONED') throw new Error(`task ${task.id} is ${task.status}`);
  const spec = parseSpec(readFileSync(task.spec_path, 'utf8'));
  if (spec.id !== task.id) throw new Error(`spec id "${spec.id}" does not match task ${task.id}`);
  const cfg = loadRepoConfig(task.worktree_path);
  const scripts = resolveScripts(spec.units, task.worktree_path);
  const version = specVersion(spec, cfg, scripts);
  if (version === task.spec_version && task.status !== 'DRAFT') return { version, reset: false };
  const now = Date.now();
  try {
    tx(db, () => {
      db.prepare("DELETE FROM unit WHERE task_id = ? AND origin = 'SPEC'").run(task.id);
      const ins = db.prepare(
        `INSERT INTO unit(task_id, id, ord, spec_version, origin, kind, description, command, cwd, timeout_ms)
         VALUES (?, ?, ?, ?, 'SPEC', ?, ?, ?, ?, ?)`,
      );
      spec.units.forEach((u, i) =>
        ins.run(task.id, u.id, i, version, u.kind, u.description, u.command ?? null, u.cwd ?? null, u.timeoutMs ?? null),
      );
      db.prepare(
        `UPDATE task SET status = 'ACTIVE', title = ?, spec_version = ?, confirmed_spec = ?, frozen_config = ?,
         resolved_scripts = ?, last_pass_tree = NULL, updated_at = ? WHERE id = ?`,
      ).run(spec.title, version, JSON.stringify(confirmedPart(spec)), JSON.stringify(cfg), JSON.stringify(scripts), now, task.id);
      event(db, task.id, 'CONFIRMED', { version });
    });
  } catch (e) {
    if (String(e).includes('UNIQUE constraint failed: task.worktree_path')) {
      const open = openTask(db, task.worktree_path)!;
      throw new Error(`task ${open.id} is already open in ${task.worktree_path}; finish or abandon it first`);
    }
    throw e;
  }
  return { version, reset: true };
}

export function confirmedPart(spec: Pick<Spec, 'units' | 'goal' | 'constraints'>) {
  return { units: spec.units, goal: spec.goal, constraints: spec.constraints };
}

export function getTask(db: DB, id: string): Task | undefined {
  return db.prepare('SELECT * FROM task WHERE id = ?').get(id) as Task | undefined;
}

export function openTask(db: DB, root: string): Task | undefined {
  return db.prepare(`SELECT * FROM task WHERE worktree_path = ? AND status IN ${OPEN}`).get(root) as Task | undefined;
}

/** Task a CLI verb acts on: the given id, else the worktree's open task, else its newest draft. */
export function pickTask(db: DB, root: string, id?: string): Task {
  const t = id
    ? getTask(db, id)
    : (openTask(db, root) ??
      (db.prepare("SELECT * FROM task WHERE worktree_path = ? AND status = 'DRAFT' ORDER BY created_at DESC LIMIT 1").get(root) as
        | Task
        | undefined));
  if (!t) throw new Error(id ? `no task ${id}` : `no open or draft task in ${root}; run \`cordata new "<title>"\``);
  return t;
}

export function attach(db: DB, taskId: string, s: { sessionId: string; transcriptPath?: string; source: string }): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO session(host_session_id, task_id, transcript_path, source, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(host_session_id, task_id) DO UPDATE SET transcript_path = excluded.transcript_path,
       source = excluded.source, last_seen_at = excluded.last_seen_at`,
  ).run(s.sessionId, taskId, s.transcriptPath ?? null, s.source, now, now);
}

export function attachedTask(db: DB, sessionId: string, root: string): Task | undefined {
  return db
    .prepare(
      `SELECT t.* FROM task t JOIN session s ON s.task_id = t.id
       WHERE s.host_session_id = ? AND t.worktree_path = ? AND t.status IN ${OPEN}`,
    )
    .get(sessionId, root) as Task | undefined;
}

export function units(db: DB, taskId: string): Unit[] {
  return db.prepare("SELECT * FROM unit WHERE task_id = ? ORDER BY origin = 'TAMPER', ord").all(taskId) as Unit[];
}

export function frozen(task: Task): FrozenConfig {
  return JSON.parse(task.frozen_config!) as FrozenConfig;
}
