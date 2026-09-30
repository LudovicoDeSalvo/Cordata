#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHooks, runHook, type HookInput } from './claude.ts';
import { resolveRepo, type Repo } from './git.ts';
import { projection, statusText } from './projection.ts';
import { CONFIG, openStore, type DB } from './store.ts';
import { confirmTask, newTask, openTask, pickTask } from './task.ts';
import { abortCurrent, verify } from './verify.ts';

const started = Date.now();
const USAGE = `usage: cordata <command>
  install [--settings <path>]   add Cordata's hooks to Claude Code settings (default ~/.claude/settings.json)
  new <title>                   create a DRAFT task in this worktree and its spec file
  confirm [task]                validate and freeze the spec (user-only)
  status [task]                 show the task, runs, snapshots and sessions
  verify [--force]              run the EXEC units now
  hook <Event>                  Claude Code hook entry (reads JSON on stdin)`;

/** D-016: these verbs are the user's, not the model's. Claude Code sets the variable in Bash, hooks and `!` mode. */
export function requireUser(verb: string): void {
  if (process.env.CLAUDE_CODE_CHILD_SESSION === '1')
    throw new Error(`cordata ${verb} is a user-only command and refuses to run inside Claude Code (CLAUDE_CODE_CHILD_SESSION=1). Run it in your own terminal.`);
}

function repoHere(): Repo {
  const repo = resolveRepo(process.cwd());
  if (!repo) throw new Error('not inside a git work tree');
  return repo;
}

function store(repo: Repo, create = false): DB {
  const db = openStore(repo.projectId, create);
  if (!db) throw new Error('no Cordata task in this repository yet; run `cordata new "<title>"`');
  return db;
}

async function readStdin(): Promise<string> {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'hook': {
      let input: HookInput = {};
      try {
        input = JSON.parse(await readStdin()) as HookInput;
      } catch {
        // not JSON: stay inert
      }
      process.stdout.write(JSON.stringify(await runHook(args[0] ?? '', input, started + CONFIG.budgetMs)));
      return 0;
    }
    case 'install': {
      const i = args.indexOf('--settings');
      const path = i >= 0 ? args[i + 1] : join(homedir(), '.claude', 'settings.json');
      if (!path) throw new Error('--settings needs a path');
      const r = installHooks(path, fileURLToPath(import.meta.url));
      console.log(r.changed ? `Cordata hooks written to ${path}${r.backup ? ` (backup: ${r.backup})` : ''}` : `Cordata hooks already current in ${path}`);
      return 0;
    }
    case 'new': {
      const title = args.join(' ').trim();
      if (!title) throw new Error('usage: cordata new <title>');
      const repo = repoHere();
      const db = store(repo, true);
      const t = newTask(db, repo, title);
      console.log(`Created ${t.id} (DRAFT). Spec: ${t.spec_path}\nFill in the units and Goal, then run \`cordata confirm ${t.id}\` in your own terminal.`);
      return 0;
    }
    case 'confirm': {
      requireUser('confirm');
      const repo = repoHere();
      const db = store(repo);
      const t = pickTask(db, repo.root, args[0]);
      const r = confirmTask(db, t);
      console.log(r.reset ? `${t.id} ACTIVE, spec version ${r.version}; unit statuses reset.` : `${t.id} unchanged (spec version ${r.version}).`);
      return 0;
    }
    case 'status': {
      const repo = repoHere();
      const db = openStore(repo.projectId, false);
      if (!db) {
        console.log('No Cordata task in this repository.');
        return 0;
      }
      const t = args[0] ? pickTask(db, repo.root, args[0]) : (openTask(db, repo.root) ?? tryPick(db, repo.root));
      console.log(statusText(db, repo.root, t));
      return 0;
    }
    case 'verify': {
      const repo = repoHere();
      const db = store(repo);
      const t = openTask(db, repo.root);
      if (!t) throw new Error('no open task in this worktree');
      const r = await verify(db, repo, t, { trigger: 'CLI', deadline: started + CONFIG.budgetMs, force: args.includes('--force') });
      if (r.reused) console.log(`Tree unchanged since run #${r.run.id}; reused (use --force to re-run).`);
      console.log(projection(db, openTask(db, repo.root) ?? t));
      return r.run.verdict === 'PASS' ? 0 : 1;
    }
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

function tryPick(db: DB, root: string) {
  try {
    return pickTask(db, root);
  } catch {
    return undefined;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const isHook = process.argv[2] === 'hook';
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(sig, () => {
      abortCurrent();
      if (isHook) process.stdout.write('{}');
      process.exit(isHook ? 0 : 130);
    });
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e: Error) => {
      if (isHook) process.stdout.write('{}'); // hooks always exit 0 with JSON (D-018)
      else console.error(`cordata: ${e.message}`);
      process.exitCode = isHook ? 0 : 1;
    },
  );
}
