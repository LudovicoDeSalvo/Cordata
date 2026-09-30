import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { installHooks } from '../src/claude.ts';
import { runCli, tmpDir, tmpRepo } from './helpers.ts';

test('install keeps foreign hooks, is idempotent, and backs up only on change (D-022)', () => {
  const dir = tmpDir();
  const path = join(dir, 'settings.json');
  const foreign = { type: 'command', command: 'echo other' };
  writeFileSync(path, JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [foreign] }] } }));
  const cli = '/opt/cordata/src/cli.ts';

  const first = installHooks(path, cli);
  assert.ok(first.changed && first.backup && existsSync(first.backup));
  const s = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(s.model, 'x');
  assert.deepEqual(s.hooks.Stop[0].hooks[0], foreign);
  const stop = s.hooks.Stop[1].hooks[0];
  assert.deepEqual(stop, { type: 'command', command: process.execPath, args: [cli, 'hook', 'Stop'], timeout: 1800 });
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Bash|Edit|Write|NotebookEdit|mcp__.*');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].async, true);

  assert.deepEqual(installHooks(path, cli), { changed: false });
  assert.equal(readdirSync(dir).filter((f) => f.includes('cordata-backup')).length, 1);
  const again = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(again.hooks.Stop.length, 2);

  const fresh = join(tmpDir(), 'nested', 'settings.json');
  assert.deepEqual(installHooks(fresh, cli), { changed: true, backup: undefined });
});

test('user-only verbs refuse inside Claude Code (D-016)', () => {
  const root = tmpRepo();
  const r = runCli(['confirm'], { home: tmpDir(), cwd: root, env: { CLAUDE_CODE_CHILD_SESSION: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /user-only command/);
});

test('hooks are inert without a task and never fail', () => {
  const home = tmpDir();
  for (const cwd of [tmpRepo(), tmpDir()]) {
    const r = runCli(['hook', 'Stop'], { home, cwd, stdin: JSON.stringify({ session_id: 's', cwd, last_assistant_message: '[cordata:ready]' }) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '{}');
  }
  assert.equal(runCli(['hook', 'Stop'], { home, cwd: tmpDir(), stdin: 'not json' }).stdout, '{}');
  assert.ok(!existsSync(join(home, '.cordata')), 'no state created (invariant 7)');
});
