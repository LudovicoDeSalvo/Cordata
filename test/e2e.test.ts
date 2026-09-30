import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { resolveRepo } from '../src/git.ts';
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

// --- milestone B -------------------------------------------------------------------------------

function db(f: ReturnType<typeof fixture>) {
  return new DatabaseSync(join(f.o.home, '.cordata', resolveRepo(f.root)!.projectId, 'cordata.sqlite'));
}
const tool = (f: ReturnType<typeof fixture>, event: string, session: string, id: string, command: string) =>
  hook(event, { session_id: session, tool_name: 'Bash', tool_input: { command }, tool_use_id: id, tool_response: 'ok' }, f.o);

test('E9: open calls become UNKNOWN for the next session, NO_RESULT at the next prompt; D-024 attach on prompt (D-017)', () => {
  const f = fixture();
  f.start('s1');
  assert.deepEqual(tool(f, 'PreToolUse', 's1', 'a1', 'git push origin main'), {});
  const ctx = f.start('s2').hookSpecificOutput.additionalContext as string;
  assert.match(ctx, /unknown outcome[\s\S]*git push origin main` \(REMOTE_WRITE, heuristic\)/);

  tool(f, 'PreToolUse', 's2', 'a2', 'npm test');
  assert.deepEqual(hook('UserPromptSubmit', { session_id: 's2', prompt: 'next' }, f.o), {});
  const outcome = (id: string) => (db(f).prepare('SELECT outcome FROM action WHERE tool_use_id = ?').get(id) as { outcome: string }).outcome;
  assert.equal(outcome('a2'), 'NO_RESULT');
  tool(f, 'PostToolUse', 's1', 'a1', 'git push origin main');
  assert.equal(outcome('a1'), 'OK', 'a late Post overwrites UNKNOWN');

  tool(f, 'PreToolUse', 's2', 'a3', 'git push origin main'); // s2 dies mid-call, then is resumed with the same id
  assert.match(f.start('s2', 'resume').hookSpecificOutput.additionalContext, /unknown outcome/);
  assert.equal(outcome('a3'), 'UNKNOWN');

  const first = hook('UserPromptSubmit', { session_id: 's3', prompt: 'hi' }, f.o);
  assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(first.hookSpecificOutput.additionalContext, /\[cordata:ready\]/);
  assert.deepEqual(hook('UserPromptSubmit', { session_id: 's3', prompt: 'again' }, f.o), {}, 'projection injected once');
  assert.deepEqual(tool(f, 'PreToolUse', 'unattached', 'x1', 'ls'), {});
  assert.equal(db(f).prepare("SELECT 1 FROM action WHERE tool_use_id = 'x1'").get(), undefined, 'invariant 7');
});

test('E10: changed test files and scripts add one TAMPER unit with (path, blob) dedup; tick accepts it (D-020, D-025)', () => {
  const units = '  - id: u1\n    kind: EXEC\n    description: answer is 42\n    command: npm test\n';
  const f = fixture(units);
  const pairs = () => (db(f).prepare('SELECT path FROM tamper_pair ORDER BY rowid').all() as { path: string }[]).map((r) => r.path);
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'node check.js' } }));
  // package.json appeared after confirm: its script is a change against the resolved (missing) script
  f.fix();
  writeFileSync(join(f.root, 'check.test.js'), 'A');
  assert.equal(runCli(['verify'], f.o).code, 0);
  assert.match(f.status(), /- ~tamper MANUAL PENDING[^\n]*check\.test\.js/);
  assert.match(f.status(), /VERIFIED_PENDING_MANUAL/);
  assert.deepEqual(pairs().sort(), ['check.test.js', 'package.json#scripts:.|test']);

  writeFileSync(join(f.root, 'check.test.js'), 'B');
  runCli(['verify'], f.o);
  writeFileSync(join(f.root, 'unrelated.txt'), 'x');
  runCli(['verify'], f.o);
  assert.deepEqual(pairs().filter((p) => p === 'check.test.js').length, 2, 'new content adds a pair, unrelated files add none');

  const t = runCli(['tick', '~tamper'], f.o);
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /t-0001 DONE/);
});

test('E11: tick on a tree changed since the last PASS re-verifies; FAIL returns to ACTIVE (D-021)', () => {
  const f = fixture(
    '  - id: u1\n    kind: EXEC\n    description: answer is 42\n    command: node check.js\n' +
      '  - id: u2\n    kind: MANUAL\n    description: looks right\n',
  );
  f.start('s1');
  f.fix();
  f.stop('s1', READY);
  writeFileSync(join(f.root, 'answer.txt'), '1\n');
  const t = runCli(['tick', 'u2'], f.o);
  assert.match(t.stdout, /re-verified: FAIL, t-0001 ACTIVE/);
  assert.equal(runCli(['tick', 'u1'], f.o).code, 1, 'EXEC units cannot be ticked');
});

test('E12: dropping Cordata hooks and Bash touching user-only verbs are tamper evidence (D-016, D-020)', () => {
  const f = fixture();
  f.start('s1');
  const settings = join(f.o.home, 'settings.json');
  writeFileSync(settings, JSON.stringify({ disableAllHooks: false, hooks: {} }));
  assert.deepEqual(hook('ConfigChange', { session_id: 's1', source: 'user_settings', file_path: settings }, f.o), {});
  tool(f, 'PreToolUse', 's1', 'b1', 'cordata confirm t-0001');
  const paths = (db(f).prepare('SELECT path FROM tamper_pair').all() as { path: string }[]).map((r) => r.path);
  assert.deepEqual(paths.map((p) => p.split(':')[0]).sort(), ['bash', 'settings']);
  assert.match(f.status(), /~tamper MANUAL PENDING/);
});

test('done and abandon are user-only overrides', () => {
  const f = fixture();
  assert.equal(runCli(['abandon'], { ...f.o, env: { CLAUDE_CODE_CHILD_SESSION: '1' } }).code, 1);
  assert.match(runCli(['abandon'], f.o).stdout, /t-0001 ABANDONED/);
  assert.deepEqual(f.start('s9'), {}, 'closed task: SessionStart is inert');
});
