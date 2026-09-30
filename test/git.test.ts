import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addExclude, git, resolveRepo, writeTree } from '../src/git.ts';
import { sh, tmpDir, tmpRepo } from './helpers.ts';

const names = (root: string, tree: string) => git(root, ['ls-tree', '-r', '--name-only', tree]).trim().split('\n');

test('worktrees share a project id and each snapshots its own content (D-022)', () => {
  const root = tmpRepo({ 'a.txt': 'a' });
  const wt = join(tmpDir(), 'wt');
  sh(root, 'git', ['worktree', 'add', '-q', wt, '-b', 'other']);
  const [r1, r2] = [resolveRepo(root)!, resolveRepo(wt)!];
  assert.equal(r1.projectId, r2.projectId);
  assert.notEqual(r1.root, r2.root);
  writeFileSync(join(wt, 'only-in-wt.txt'), 'x');
  assert.ok(names(wt, writeTree(wt)).includes('only-in-wt.txt'));
  assert.ok(!names(root, writeTree(root)).includes('only-in-wt.txt'));
});

test('snapshot includes untracked, excludes ignored, leaves index and HEAD untouched (invariant 6)', () => {
  const root = tmpRepo({ '.gitignore': 'ignored.txt\n', 'a.txt': 'a' });
  const index = readFileSync(join(root, '.git', 'index'));
  const head = sh(root, 'git', ['rev-parse', 'HEAD']);
  writeFileSync(join(root, 'a.txt'), 'changed');
  writeFileSync(join(root, 'untracked.txt'), 'u');
  writeFileSync(join(root, 'ignored.txt'), 'i');
  const tree = writeTree(root);
  assert.deepEqual(names(root, tree).sort(), ['.gitignore', 'a.txt', 'untracked.txt']);
  assert.ok(readFileSync(join(root, '.git', 'index')).equals(index));
  assert.equal(sh(root, 'git', ['rev-parse', 'HEAD']), head);
  assert.equal(sh(root, 'git', ['diff', '--cached', '--name-only']), '');
});

test('unborn repo snapshots to the empty tree', () => {
  const root = tmpRepo({}, false);
  assert.equal(writeTree(root), '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
});

test('leaked GIT_DIR / GIT_INDEX_FILE in the environment are ignored', () => {
  const root = tmpRepo({ 'a.txt': 'a' });
  const saved = { ...process.env };
  process.env.GIT_DIR = '/nonexistent';
  process.env.GIT_INDEX_FILE = '/nonexistent/index';
  try {
    assert.ok(names(root, writeTree(root)).includes('a.txt'));
    assert.ok(resolveRepo(root));
  } finally {
    process.env = saved;
  }
});

test('addExclude is idempotent and outside a repo resolveRepo is null', () => {
  const root = tmpRepo();
  addExclude(root, '/.cordata/');
  addExclude(root, '/.cordata/');
  const lines = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').split('\n');
  assert.equal(lines.filter((l) => l === '/.cordata/').length, 1);
  assert.equal(resolveRepo(tmpDir()), null);
});
