import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_GLOBS, parseSpec, resolveScripts, skeleton, specVersion, type UnitSpec } from '../src/spec.ts';
import { tmpRepo } from './helpers.ts';

const SPEC = `---
id: t-0001
title: Add refresh tokens
units:
  - id: u1
    kind: EXEC
    description: tests pass
    command: npm test -- auth
    timeoutMs: 120000
  - id: u2
    kind: MANUAL
    description: reviewed in browser
---
## Goal
Refresh tokens work.
## Constraints
No new dependency.
## Notes
free text
`;

test('parses a valid spec', () => {
  const s = parseSpec(SPEC);
  assert.equal(s.id, 't-0001');
  assert.equal(s.units.length, 2);
  assert.deepEqual(s.units[0], { id: 'u1', kind: 'EXEC', description: 'tests pass', command: 'npm test -- auth', timeoutMs: 120000 });
  assert.equal(s.goal, 'Refresh tokens work.');
  assert.equal(s.constraints, 'No new dependency.');
});

test('rejects invalid specs, listing every problem', () => {
  const bad = `---
id: t-0001
title: x
extra: 1
units:
  - id: u1
    kind: EXEC
    description: no command
  - id: u1
    kind: MANUAL
    description: dup with command
    command: echo
  - id: u3
    kind: EXEC
    description: escapes
    command: ls
    cwd: ../other
    timeout: 5
---
## Goal
`;
  assert.throws(() => parseSpec(bad), (e: Error) => {
    for (const s of ['unknown key "extra"', 'EXEC unit needs a command', 'duplicate id "u1"', 'MANUAL unit must not have a command',
      'cwd must be a relative path', 'unknown key "timeout"', '"## Goal" section is empty'])
      assert.ok(e.message.includes(s), `missing: ${s}\n${e.message}`);
    return true;
  });
  assert.throws(() => parseSpec(SPEC.replace(/  - id: u1[\s\S]*?timeoutMs: 120000\n/, '')), /at least one EXEC unit/);
  assert.throws(() => parseSpec('no frontmatter'), /frontmatter/);
});

test('skeleton parses once a Goal is written', () => {
  assert.throws(() => parseSpec(skeleton('t-0002', 'x: "quoted"')), /Goal/);
  const s = parseSpec(skeleton('t-0002', 'x: "quoted"').replace('## Goal\n', '## Goal\ndo it\n'));
  assert.equal(s.title, 'x: "quoted"');
});

test('spec version ignores Title and Notes, tracks everything the gate depends on (D-021)', () => {
  const cfg = { globs: DEFAULT_GLOBS, failCap: 3 };
  const v = (text: string, c = cfg, scripts = {}) => specVersion(parseSpec(text), c, scripts);
  const base = v(SPEC);
  assert.equal(v(SPEC.replace('title: Add refresh tokens', 'title: Renamed').replace('free text', 'other notes')), base);
  assert.notEqual(v(SPEC.replace('Refresh tokens work.', 'Different goal.')), base);
  assert.notEqual(v(SPEC.replace('No new dependency.', 'Anything goes.')), base);
  assert.notEqual(v(SPEC.replace('npm test -- auth', 'npm test')), base);
  assert.notEqual(v(SPEC, { ...cfg, failCap: 5 }), base);
  assert.notEqual(v(SPEC, cfg, { '.|test': 'vitest' }), base);
});

test('resolves package scripts behind unit commands (D-020)', () => {
  const root = tmpRepo({
    'package.json': JSON.stringify({ scripts: { test: 'npm run lint && vitest', lint: 'eslint .', x: 'echo x' } }),
    'sub/package.json': JSON.stringify({ scripts: { check: 'tsc' } }),
  });
  const u = (command: string, cwd?: string): UnitSpec => ({ id: 'u', kind: 'EXEC', description: 'd', command, ...(cwd ? { cwd } : {}) });
  assert.deepEqual(resolveScripts([u('npm test')], root), { '.|test': 'npm run lint && vitest', '.|lint': 'eslint .' });
  assert.deepEqual(resolveScripts([u('npm run x -- --flag')], root), { '.|x': 'echo x' });
  assert.deepEqual(resolveScripts([u('pnpm x'), u('yarn run lint')], root), { '.|x': 'echo x', '.|lint': 'eslint .' });
  assert.deepEqual(resolveScripts([u('make && npm run missing')], root), { '.|missing': null });
  assert.deepEqual(resolveScripts([u('npm install && node check.js'), u('yarn install')], root), {});
  assert.deepEqual(resolveScripts([u('pnpm check', 'sub')], root), { 'sub|check': 'tsc' });
});
