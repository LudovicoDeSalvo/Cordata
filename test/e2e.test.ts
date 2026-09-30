import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hook, runCli, sh, tmpDir, tmpRepo } from './helpers.ts';

const CHECK = 'process.exit(require("fs").readFileSync("answer.txt", "utf8").trim() === "42" ? 0 : 1)\n';
const READY = 'Implemented. [cordata:ready]';

/** Fixture: a repo whose check.js fails until answer.txt holds 42, with a confirmed task t-0001. */
function fixture(units = '  - id: u1\n    kind: EXEC\n    description: answer is 42\n    command: node check.js\n') {
  const root = tmpRepo({ 'check.js': CHECK, 'answer.txt': '1\n' });
  const home = tmpDir('cordata-home-');
  const o = { home, cwd: root };
  assert.equal(runCli(['new', 'Fix the answer'], o).code, 0);
  writeFileSync(join(root, '.cordata/tasks/t-0001.md'), `---\nid: t-0001\ntitle: Fix the answer\nunits:\n${units}---\n## Goal\nanswer.txt holds 42\n`);
  const c = runCli(['confirm'], o);
  assert.equal(c.code, 0, c.stderr);
  const stop = (session: string, message: string, continuing = false) =>
    hook('Stop', { session_id: session, last_assistant_message: message, stop_hook_active: continuing, background_tasks: [] }, o);
  const start = (session: string, source = 'startup') => hook('SessionStart', { session_id: session, source, transcript_path: '/t.jsonl' }, o);
  const status = () => runCli(['status', 't-0001'], o).stdout;
  const refs = () => sh(root, 'git', ['for-each-ref', '--format=%(refname)', 'refs/cordata/']).trim().split('\n');
  return { root, o, stop, start, status, refs, fix: () => writeFileSync(join(root, 'answer.txt'), '42\n') };
}

test('E1: SessionStart projects the task; a fork attaches its new session (D-023)', () => {
  const f = fixture();
  const ctx = f.start('s1').hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'SessionStart');
  assert.match(ctx.additionalContext, /answer\.txt holds 42/);
  assert.match(ctx.additionalContext, /\[cordata:ready\]/);
  assert.ok(f.start('s2', 'fork').hookSpecificOutput);
  assert.match(f.status(), /- s2 last seen/);
});

test('E2: an unmarked Stop allows without running anything (D-015)', () => {
  const f = fixture();
  f.start('s1');
  assert.deepEqual(f.stop('s1', 'Here is a question for you?'), {});
  assert.match(f.status(), /No verification run yet/);
});

test('E3/E4/E5: marked claim FAIL blocks, unchanged tree reuses, fix PASSes to DONE (D-015, D-018)', () => {
  const f = fixture();
  f.start('s1');
  const r = f.stop('s1', READY);
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /run #1 FAIL/);
  assert.ok(f.refs().includes('refs/cordata/t-0001/1'));

  const again = f.stop('s1', READY, true);
  assert.equal(again.decision, undefined);
  assert.match(again.systemMessage, /unchanged since run #1/);
  assert.ok(!f.refs().includes('refs/cordata/t-0001/2'));

  f.fix();
  assert.match(f.stop('s1', READY, true).systemMessage, /run #2 PASS: task t-0001 DONE/);
  assert.match(runCli(['status'], f.o).stdout, /t-0001 DONE/);
});

test('E5b: PASS with a pending MANUAL unit is VERIFIED_PENDING_MANUAL (D-021)', () => {
  const f = fixture(
    '  - id: u1\n    kind: EXEC\n    description: answer is 42\n    command: node check.js\n' +
      '  - id: u2\n    kind: MANUAL\n    description: looks right\n',
  );
  f.start('s1');
  f.fix();
  assert.match(f.stop('s1', READY).systemMessage, /manual units pending/);
  assert.match(f.status(), /VERIFIED_PENDING_MANUAL/);
});

test('E6: the first ERROR blocks as infrastructure, the second allows (D-018)', () => {
  const f = fixture('  - id: u1\n    kind: EXEC\n    description: broken\n    command: nosuchcmd-xyz\n');
  f.start('s1');
  const r = f.stop('s1', READY);
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /^\[infrastructure error\]/);
  f.fix(); // change the tree so the claim re-runs
  const second = f.stop('s1', READY, true);
  assert.equal(second.decision, undefined);
  assert.match(second.systemMessage, /ERROR again; stop allowed/);
});

test('E7: FAIL blocks at most 3 times per chain; a new chain resets the count (D-015, D-025)', () => {
  const f = fixture();
  f.start('s1');
  const claim = (i: number, continuing: boolean) => {
    writeFileSync(join(f.root, 'scratch.txt'), String(i)); // new tree each time
    return f.stop('s1', READY, continuing);
  };
  for (let i = 1; i <= 3; i++) assert.equal(claim(i, i > 1).decision, 'block', `claim ${i}`);
  const fourth = claim(4, true);
  assert.equal(fourth.decision, undefined);
  assert.match(fourth.systemMessage, /stop allowed after 3 blocked claims/);
  assert.equal(claim(5, false).decision, 'block', 'stop_hook_active=false starts a new chain');
});

test('E8: an internal failure allows the stop and records GATE_BYPASS (D-018)', { skip: process.getuid?.() === 0 }, () => {
  const f = fixture();
  f.start('s1');
  const dir = join(f.root, '.git/refs/cordata/t-0001');
  chmodSync(dir, 0o555);
  try {
    assert.deepEqual(f.stop('s1', READY), {});
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.match(f.status(), /Gate bypasses recorded: 1/);
  assert.match(f.status(), /ABORTED/);
});
