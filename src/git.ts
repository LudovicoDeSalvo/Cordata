import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type Repo = { projectId: string; commonDir: string; root: string };

/**
 * Runs git with every GIT_* variable stripped (a hook env may carry GIT_DIR/GIT_INDEX_FILE) and
 * GIT_OPTIONAL_LOCKS=0 so read commands never refresh the user's index (invariant 6).
 */
export function git(cwd: string, args: string[], extra: Record<string, string> = {}, input?: string): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  return execFileSync('git', ['-C', cwd, ...args], {
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', ...extra },
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Project = git common dir, shared by all worktrees (D-022). Null outside a work tree: Cordata stays inert. */
export function resolveRepo(cwd: string): Repo | null {
  let out: string;
  try {
    out = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']);
  } catch {
    return null;
  }
  const [common, top] = out.trim().split('\n');
  if (!common || !top) return null;
  const commonDir = realpathSync(common);
  return { projectId: sha256(commonDir).slice(0, 16), commonDir, root: realpathSync(top) };
}

export function branch(root: string): string | null {
  try {
    return git(root, ['symbolic-ref', '-q', '--short', 'HEAD']).trim() || null;
  } catch {
    return null; // detached HEAD
  }
}

/**
 * Tree of the worktree's non-ignored content, written through a temporary index seeded from a copy of
 * the real one (stat cache keeps it fast). The user's index and HEAD are never touched.
 */
export function writeTree(root: string): string {
  const idx = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
  const tmp = mkdtempSync(join(tmpdir(), 'cordata-'));
  try {
    const tmpIndex = join(tmp, 'index');
    if (existsSync(idx)) copyFileSync(idx, tmpIndex); // unborn repo: no index yet, start empty
    const env = { GIT_INDEX_FILE: tmpIndex };
    git(root, ['add', '-A'], env);
    return git(root, ['write-tree'], env).trim();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function pinRef(root: string, ref: string, tree: string): void {
  git(root, ['update-ref', ref, tree]);
}

/** Appends a line to info/exclude (in the common dir, so it covers every worktree) unless present. */
export function addExclude(root: string, line: string): void {
  const file = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']).trim();
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split('\n').includes(line)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + line + '\n');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
