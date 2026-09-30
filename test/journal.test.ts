import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { hooksIntact } from '../src/claude.ts';
import { resolveRepo } from '../src/git.ts';
import { classify, closeOpen, mentionsCordata, recordTool } from '../src/journal.ts';
import { openStore } from '../src/store.ts';
import { tmpDir, tmpRepo } from './helpers.ts';

process.env.HOME = tmpDir('cordata-home-');

test('effect classifier (heuristic, D-010)', () => {
  const bash = (command: string) => classify('Bash', { command });
  assert.equal(classify('Edit', {}), 'LOCAL_WRITE');
  assert.equal(classify('mcp__github__create_issue', {}), 'REMOTE_WRITE');
  assert.equal(bash('git status'), 'READ');
  assert.equal(bash('ls -la src'), 'READ');
  assert.equal(bash('cat a > b'), 'LOCAL_WRITE');
  assert.equal(bash('npm test'), 'LOCAL_WRITE');
  assert.equal(bash('git push origin main'), 'REMOTE_WRITE');
  assert.equal(bash('curl -X POST https://x'), 'REMOTE_WRITE');
  assert.equal(bash('rm -rf build'), 'DESTRUCTIVE');
  assert.equal(bash('git reset --hard HEAD~1'), 'DESTRUCTIVE');
  assert.equal(bash('git push --force origin x'), 'DESTRUCTIVE');
});

test('mentionsCordata flags user-only verbs and state, not specs (D-016)', () => {
  for (const c of ['cordata confirm', 'npx cordata tick u2', 'cat ~/.cordata/x', `ls ${homedir()}/.cordata`, 'sqlite3 cordata.sqlite', 'CORDATA_HOME=/tmp x'])
    assert.ok(mentionsCordata(c), c);
  for (const c of ['cat .cordata/tasks/t-0001.md', 'cordata status', 'cordata verify', 'echo cordata']) assert.ok(!mentionsCordata(c), c);
});

test('action upserts survive async ordering (D-014, D-017)', () => {
  const repo = resolveRepo(tmpRepo())!;
  const db = openStore(repo.projectId, true)!;
  db.prepare("INSERT INTO task(id, worktree_path, title, spec_path, status, start_tree, created_at, updated_at) VALUES ('t-0001', ?, 't', 'x', 'ACTIVE', 'x', 0, 0)").run(repo.root);
  const ev = (id: string) => ({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: id, tool_response: 'ok' });
  const outcome = (id: string) => (db.prepare('SELECT outcome FROM action WHERE tool_use_id = ?').get(id) as { outcome: string | null }).outcome;

  recordTool(db, 't-0001', 'post', ev('a')); // Post before Pre
  recordTool(db, 't-0001', 'pre', ev('a'));
  assert.equal(outcome('a'), 'OK');

  recordTool(db, 't-0001', 'pre', ev('b'));
  assert.equal(outcome('b'), null);
  closeOpen(db, 's1');
  assert.equal(outcome('b'), 'NO_RESULT');
  recordTool(db, 't-0001', 'post', ev('b')); // late Post wins
  assert.equal(outcome('b'), 'OK');

  recordTool(db, 't-0001', 'failure', { ...ev('c'), error: 'Exit code 1' });
  assert.equal(outcome('c'), 'ERROR');
});

test('hooksIntact catches disableAllHooks and a dropped Cordata Stop hook (D-020)', () => {
  const cordata = { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/node', args: ['/x/src/cli.ts', 'hook', 'Stop'] }] }] } };
  assert.ok(hooksIntact(cordata, true));
  assert.ok(!hooksIntact({ ...cordata, disableAllHooks: true }, true));
  assert.ok(!hooksIntact({ hooks: {} }, true));
  assert.ok(hooksIntact({ hooks: {} }, false), 'project settings never held Cordata hooks');
});
