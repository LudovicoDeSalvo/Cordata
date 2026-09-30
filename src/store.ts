import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ponytail: constants instead of ~/.cordata/config.json (D-025); make one configurable when it needs to change.
export const CONFIG = {
  marker: '[cordata:ready]',
  budgetMs: 1_740_000, // Stop hook timeout 1800 s − 60 s (D-018)
  staleLeaseMs: 1_800_000,
  failCap: 3,
  largeFileBytes: 10 * 1024 * 1024,
  retentionDays: 30,
  keepRuns: 5,
  cap: 4000, // projection and block reason (D-023)
} as const;

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE project(id TEXT PRIMARY KEY, git_common_dir TEXT NOT NULL);
CREATE TABLE task(
  id TEXT PRIMARY KEY, worktree_path TEXT NOT NULL, branch_at_creation TEXT, title TEXT NOT NULL,
  spec_path TEXT NOT NULL, spec_version TEXT, confirmed_spec TEXT, frozen_config TEXT, resolved_scripts TEXT,
  status TEXT NOT NULL CHECK(status IN ('DRAFT','ACTIVE','VERIFIED_PENDING_MANUAL','DONE','ABANDONED')),
  parent_id TEXT, after TEXT NOT NULL DEFAULT '[]', start_tree TEXT NOT NULL, last_pass_tree TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER);
CREATE UNIQUE INDEX task_one_open ON task(worktree_path) WHERE status IN ('ACTIVE','VERIFIED_PENDING_MANUAL');
CREATE TABLE unit(
  task_id TEXT NOT NULL REFERENCES task, id TEXT NOT NULL, ord INTEGER NOT NULL, spec_version TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('SPEC','TAMPER')), kind TEXT NOT NULL CHECK(kind IN ('EXEC','MANUAL')),
  description TEXT NOT NULL, command TEXT, cwd TEXT, timeout_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PASS','FAIL','ERROR','TICKED')),
  last_run_id INTEGER, tick_tree TEXT, ticked_at INTEGER,
  PRIMARY KEY(task_id, id));
CREATE TABLE tamper_pair(
  task_id TEXT NOT NULL, path TEXT NOT NULL, blob TEXT NOT NULL, unit_id TEXT NOT NULL, run_id INTEGER, at INTEGER NOT NULL,
  PRIMARY KEY(task_id, path, blob));
CREATE TABLE session(
  host_session_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES task, transcript_path TEXT, source TEXT NOT NULL,
  started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  fail_count INTEGER NOT NULL DEFAULT 0, error_blocked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(host_session_id, task_id));
CREATE INDEX session_task ON session(task_id, last_seen_at);
CREATE TABLE action(
  tool_use_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, host_session_id TEXT NOT NULL, tool TEXT NOT NULL,
  input_hash TEXT, input_excerpt TEXT, effect_class TEXT, started_at INTEGER, ended_at INTEGER,
  outcome TEXT CHECK(outcome IN ('OK','ERROR','NO_RESULT','UNKNOWN')), output_excerpt TEXT);
CREATE INDEX action_open ON action(host_session_id) WHERE outcome IS NULL;
CREATE TABLE run(
  id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task,
  trigger TEXT NOT NULL CHECK(trigger IN ('STOP','CLI','TICK')), host_session_id TEXT,
  spec_version TEXT NOT NULL, tree_hash TEXT NOT NULL, tree_after TEXT, ref TEXT, lease_pid INTEGER,
  started_at INTEGER NOT NULL, ended_at INTEGER, verdict TEXT CHECK(verdict IN ('PASS','FAIL','ERROR')),
  note TEXT, warnings TEXT, tamper TEXT);
CREATE UNIQUE INDEX run_lease ON run(task_id) WHERE ended_at IS NULL;
CREATE INDEX run_last ON run(task_id, spec_version, id);
CREATE TABLE unit_result(
  run_id INTEGER NOT NULL REFERENCES run, unit_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PASS','FAIL','ERROR')), exit_code INTEGER, signal TEXT, error TEXT,
  duration_ms INTEGER, stdout TEXT, stderr TEXT,
  PRIMARY KEY(run_id, unit_id));
CREATE TABLE task_event(seq INTEGER PRIMARY KEY, task_id TEXT, type TEXT NOT NULL, payload TEXT, at INTEGER NOT NULL);
`;

/** State root; CORDATA_HOME lets the smoke test keep a real Claude login without touching ~/.cordata. */
export function cordataHome(): string {
  return process.env.CORDATA_HOME || join(homedir(), '.cordata');
}

/** Opens the project DB. With create=false a missing DB returns null: hooks never create state (invariant 7). */
export function openStore(projectId: string, create: boolean): DB | null {
  const dir = join(cordataHome(), projectId);
  const file = join(dir, 'cordata.sqlite');
  if (!create && !existsSync(file)) return null;
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  if (version(db) === 0) {
    tx(db, () => {
      if (version(db) === 0) db.exec(SCHEMA + 'PRAGMA user_version = 1;');
    });
  }
  return db;
}

function version(db: DB): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function event(db: DB, taskId: string | null, type: string, payload?: object): void {
  db.prepare('INSERT INTO task_event(task_id, type, payload, at) VALUES (?, ?, ?, ?)').run(
    taskId,
    type,
    payload === undefined ? null : JSON.stringify(payload),
    Date.now(),
  );
}

/** Last-resort record when the DB itself is unusable (D-018). */
export function logBypass(e: object): void {
  try {
    mkdirSync(cordataHome(), { recursive: true });
    appendFileSync(join(cordataHome(), 'bypass.log'), JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
  } catch {
    // nothing left to record to
  }
}
