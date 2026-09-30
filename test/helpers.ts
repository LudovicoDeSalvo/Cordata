import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export function tmpDir(prefix = 'cordata-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Env for child processes: no GIT_* leakage, not "inside Claude Code" unless a test says so. */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith('GIT_') && k !== 'CLAUDE_CODE_CHILD_SESSION' && k !== 'CLAUDECODE') env[k] = v;
  return { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...extra };
}

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, env: cleanEnv(), encoding: 'utf8' });
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
}

/** A fresh repo with the files committed on `main` (commit=false leaves it unborn). */
export function tmpRepo(files: Record<string, string> = {}, commit = true): string {
  const root = tmpDir('cordata-repo-');
  sh(root, 'git', ['init', '-q', '-b', 'main']);
  writeFiles(root, files);
  if (commit) {
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-q', '--allow-empty', '-m', 'init']);
  }
  return root;
}

export function runCli(args: string[], o: { home: string; cwd: string; stdin?: string; env?: Record<string, string> }) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: o.cwd,
    input: o.stdin ?? '',
    env: cleanEnv({ HOME: o.home, ...o.env }),
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Pipes a hook event into `cordata hook <event>` and parses the JSON it prints. */
export function hook(event: string, input: object, o: { home: string; cwd: string }): Record<string, any> {
  const r = runCli(['hook', event], { ...o, stdin: JSON.stringify({ cwd: o.cwd, ...input }) });
  if (r.code !== 0) throw new Error(`hook exited ${r.code}: ${r.stderr}`);
  return JSON.parse(r.stdout) as Record<string, any>;
}
