import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveRepo } from '../src/git.ts';
import { projection } from '../src/projection.ts';
import { openStore } from '../src/store.ts';
import { confirmTask, getTask, newTask } from '../src/task.ts';
import { runUnit, verify } from '../src/verify.ts';
import { tmpDir, tmpRepo } from './helpers.ts';

process.env.HOME = tmpDir('cordata-home-');
const far = () => Date.now() + 60_000;
const unit = (command: string, extra: { cwd?: string; timeout_ms?: number } = {}) => ({
  id: 'u', command, cwd: extra.cwd ?? null, timeout_ms: extra.timeout_ms ?? null,
});

/** A repo with a confirmed task whose EXEC units are the given commands. */
function setup(commands: string[], files: Record<string, string> = {}) {
  const root = tmpRepo({ 'answer.txt': '1\n', ...files });
  const repo = resolveRepo(root)!;
  const db = openStore(repo.projectId, true)!;
  const t = newTask(db, repo, 'test');
  const units = commands.map((c, i) => `  - id: u${i + 1}\n    kind: EXEC\n    description: unit ${i + 1}\n    command: ${JSON.stringify(c)}\n`).join('');
  writeFileSync(t.spec_path, `---\nid: ${t.id}\ntitle: test\nunits:\n${units}---\n## Goal\ng\n`);
  confirmTask(db, t);
  return { root, repo, db, task: getTask(db, t.id)! };
}

test('runner verdicts: 0 PASS, 1 FAIL, 127 ERROR (D-018)', async () => {
  const root = tmpDir();
  assert.equal((await runUnit(unit('echo hi'), root, far())).status, 'PASS');
  const f = await runUnit(unit('echo boom >&2; exit 1'), root, far());
  assert.equal(f.status, 'FAIL');
  assert.equal(f.exit_code, 1);
  assert.equal(f.stderr.trim(), 'boom');
  assert.equal((await runUnit(unit('nosuchcommand-xyz'), root, far())).status, 'ERROR');
});

test('timeout kills the whole process group', async () => {
  const root = tmpDir();
  const t0 = Date.now();
  const r = await runUnit(unit('echo $$ > pgid; sleep 60 & sleep 60', { timeout_ms: 300 }), root, far());
  assert.equal(r.status, 'ERROR');
  assert.match(r.error!, /timed out/);
  assert.ok(Date.now() - t0 < 7000);
  const pgid = Number(readFileSync(join(root, 'pgid'), 'utf8'));
  assert.throws(() => process.kill(-pgid, 0), { code: 'ESRCH' });
});

test('missing cwd and an exhausted budget are ERROR without spawning', async () => {
  const root = tmpDir();
  assert.match((await runUnit(unit('true', { cwd: 'nope' }), root, far())).error!, /cwd not found/);
  const r = await runUnit(unit('touch spawned'), root, Date.now() - 1);
  assert.equal(r.status, 'ERROR');
  assert.ok(!existsSync(join(root, 'spawned')));
});

test('output capture keeps head and tail of large output', async () => {
  const r = await runUnit(unit('head -c 200000 /dev/zero | tr "\\0" x; echo END'), tmpDir(), far());
  assert.ok(r.stdout.length < 70 * 1024);
  assert.match(r.stdout, /bytes truncated/);
  assert.ok(r.stdout.trimEnd().endsWith('END'));
});

test('a verifier that writes into the worktree makes the run ERROR (D-018 tree check)', async () => {
  const { db, repo, task } = setup(['echo 2 >> answer.txt']);
  const r = await verify(db, repo, task, { trigger: 'CLI', deadline: far() });
  assert.equal(r.run.verdict, 'ERROR');
  assert.match(r.run.note!, /worktree changed/);
  assert.equal(getTask(db, task.id)!.status, 'ACTIVE');
});

test('a stale lease (dead pid) is taken over', async () => {
  const { db, repo, task } = setup(['true']);
  db.prepare("INSERT INTO run(task_id, trigger, spec_version, tree_hash, lease_pid, started_at) VALUES (?, 'CLI', ?, 'x', 999999, ?)").run(
    task.id, task.spec_version, Date.now(),
  );
  const r = await verify(db, repo, task, { trigger: 'CLI', deadline: far() });
  assert.equal(r.run.verdict, 'PASS');
  assert.equal(getTask(db, task.id)!.status, 'DONE');
  assert.equal((db.prepare("SELECT note FROM run WHERE tree_hash = 'x'").get() as { note: string }).note, 'stale lease');
});

test('a second claim waits for the running one, then reuses its result', async () => {
  const { db, repo, task } = setup(['sleep 1']);
  const first = verify(db, repo, task, { trigger: 'STOP', sessionId: 'a', deadline: far() });
  const second = verify(db, repo, task, { trigger: 'STOP', sessionId: 'b', deadline: far() });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(a.run.id, b.run.id);
});

test('projection stays under the cap, trimming excerpts before collapsing lists (D-023)', async () => {
  const noisy = 'for i in $(seq 120); do echo "error line $i with some padding to make it long enough" >&2; done; exit 1';
  const { db, repo, task } = setup(Array(6).fill(noisy));
  await verify(db, repo, task, { trigger: 'CLI', deadline: far() });
  const text = projection(db, getTask(db, task.id)!);
  assert.ok(text.length <= 4000, `length ${text.length}`);
  for (let i = 1; i <= 6; i++) assert.ok(text.includes(`- u${i} EXEC FAIL`), `u${i} listed`);
  assert.ok(text.includes('error line 120'), 'keeps the last stderr line');
  assert.ok(text.endsWith('full state: `cordata status`'));
});

test('diffTrees reports changes and deletes; prune keeps start, last PASS and the last 5 runs (D-022)', async () => {
  const { db, repo, task, root } = setup(['grep -q 42 answer.txt'], { 'gone.txt': 'x' });
  const { diffTrees, listRefs, writeTree } = await import('../src/git.ts');
  const { unlinkSync } = await import('node:fs');
  unlinkSync(join(root, 'gone.txt'));
  writeFileSync(join(root, 'answer.txt'), '42\n');
  const d = diffTrees(root, task.start_tree, writeTree(root));
  assert.deepEqual(d.map((p) => p.path).sort(), ['answer.txt', 'gone.txt']);
  assert.match(d.find((p) => p.path === 'gone.txt')!.blob, /^0+$/);

  const pass = await verify(db, repo, task, { trigger: 'CLI', deadline: far() }); // run 1 PASS → DONE; reopen to keep going
  db.prepare("UPDATE task SET status = 'ACTIVE', closed_at = NULL WHERE id = ?").run(task.id);
  writeFileSync(join(root, 'answer.txt'), '1\n');
  for (let i = 0; i < 7; i++) {
    writeFileSync(join(root, 'n.txt'), String(i));
    await verify(db, repo, getTask(db, task.id)!, { trigger: 'CLI', deadline: far() });
  }
  const refs = listRefs(root, `refs/cordata/${task.id}/`).map((r) => r.split('/').pop()).sort();
  assert.deepEqual(refs, ['1', '4', '5', '6', '7', '8', 'start'].sort());
  assert.equal(pass.run.id, 1);
  assert.equal((db.prepare('SELECT count(*) AS n FROM run WHERE ref IS NULL').get() as { n: number }).n, 2);
});
