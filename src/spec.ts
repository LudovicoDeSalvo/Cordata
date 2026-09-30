import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { parse, stringify } from 'yaml';
import { sha256 } from './git.ts';
import { CONFIG } from './store.ts';

export type UnitSpec = {
  id: string;
  kind: 'EXEC' | 'MANUAL';
  description: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
};
export type Spec = { id: string; title: string; units: UnitSpec[]; goal: string; constraints: string; notes: string };
export type FrozenConfig = { globs: string[]; failCap: number };
/** `<cwd>|<script name>` → script text, or null when package.json has no such script. */
export type Scripts = Record<string, string | null>;

export const DEFAULT_GLOBS = [
  '**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**', 'conftest.py',
  'vitest.config.*', 'jest.config.*', 'playwright.config.*', 'tsconfig*.json', 'eslint.config.*', '.eslintrc*',
  'pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml', '.github/workflows/**',
];

const TOP_KEYS = new Set(['id', 'title', 'units']);
const UNIT_KEYS = new Set(['id', 'kind', 'description', 'command', 'cwd', 'timeoutMs']);

/** Parses and validates a task spec file; throws one error listing every problem. */
export function parseSpec(text: string): Spec {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) throw new Error('invalid spec:\n- missing YAML frontmatter between --- lines');
  const errors: string[] = [];
  let fm: unknown;
  try {
    fm = parse(m[1]!);
  } catch (e) {
    throw new Error(`invalid spec:\n- frontmatter is not valid YAML: ${(e as Error).message}`);
  }
  if (!isObj(fm)) throw new Error('invalid spec:\n- frontmatter must be a mapping');
  for (const k of Object.keys(fm)) if (!TOP_KEYS.has(k)) errors.push(`unknown key "${k}"`);
  if (typeof fm.id !== 'string' || !fm.id) errors.push('id must be a non-empty string');
  if (typeof fm.title !== 'string' || !fm.title) errors.push('title must be a non-empty string');

  const units: UnitSpec[] = [];
  if (!Array.isArray(fm.units) || fm.units.length === 0) errors.push('units must be a non-empty list');
  else {
    const seen = new Set<string>();
    fm.units.forEach((u: unknown, i: number) => {
      const at = `units[${i}]`;
      if (!isObj(u)) return errors.push(`${at} must be a mapping`);
      for (const k of Object.keys(u)) if (!UNIT_KEYS.has(k)) errors.push(`${at}: unknown key "${k}"`);
      const { id, kind, description, command, cwd, timeoutMs } = u;
      if (typeof id !== 'string' || !/^[A-Za-z0-9][\w.-]*$/.test(id)) errors.push(`${at}: id must match [A-Za-z0-9][\\w.-]*`);
      else if (seen.has(id)) errors.push(`${at}: duplicate id "${id}"`);
      else seen.add(id);
      if (kind !== 'EXEC' && kind !== 'MANUAL') errors.push(`${at}: kind must be EXEC or MANUAL`);
      if (typeof description !== 'string' || !description.trim()) errors.push(`${at}: description is required`);
      if (kind === 'EXEC' && (typeof command !== 'string' || !command.trim())) errors.push(`${at}: EXEC unit needs a command`);
      if (kind === 'MANUAL' && command !== undefined) errors.push(`${at}: MANUAL unit must not have a command`);
      if (cwd !== undefined && (typeof cwd !== 'string' || isAbsolute(cwd) || normalize(cwd).startsWith('..')))
        errors.push(`${at}: cwd must be a relative path inside the repo`);
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0))
        errors.push(`${at}: timeoutMs must be a positive integer`);
      units.push(clean({ id, kind, description, command, cwd, timeoutMs }) as UnitSpec);
    });
    if (!units.some((u) => u.kind === 'EXEC')) errors.push('at least one EXEC unit is required');
  }

  const sections = splitSections(m[2]!);
  const goal = sections.get('goal') ?? '';
  if (!goal) errors.push('the "## Goal" section is empty');
  if (errors.length) throw new Error('invalid spec:\n- ' + errors.join('\n- '));
  return {
    id: fm.id as string,
    title: fm.title as string,
    units,
    goal,
    constraints: sections.get('constraints') ?? '',
    notes: sections.get('notes') ?? '',
  };
}

function splitSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null;
  let buf: string[] = [];
  const flush = () => name && out.set(name, buf.join('\n').trim());
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      flush();
      name = h[1]!.toLowerCase();
      buf = [];
    } else buf.push(line);
  }
  flush();
  return out;
}

export function loadRepoConfig(root: string): FrozenConfig {
  const file = join(root, '.cordata', 'config.json');
  const cfg: FrozenConfig = { globs: DEFAULT_GLOBS, failCap: CONFIG.failCap };
  if (!existsSync(file)) return cfg;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!isObj(raw)) throw new Error(`${file}: must be a JSON object`);
  if (raw.globs !== undefined) {
    if (!Array.isArray(raw.globs) || !raw.globs.every((g) => typeof g === 'string')) throw new Error(`${file}: globs must be a list of strings`);
    cfg.globs = raw.globs as string[];
  }
  if (raw.failCap !== undefined) {
    if (!Number.isInteger(raw.failCap) || (raw.failCap as number) < 0) throw new Error(`${file}: failCap must be a non-negative integer`);
    cfg.failCap = raw.failCap as number;
  }
  return cfg;
}

// ponytail: covers `npm test|t`, `npm run x`, `pnpm|yarn [run] x`, one regex; flags before the script name are not parsed.
const SCRIPT_RE = /\b(npm|pnpm|yarn)\s+(run(?:-script)?\s+)?([\w:.-]+)/g;
const NPM_BARE = new Set(['test', 't', 'start', 'stop', 'restart']);

/** Resolves package-script invocations in EXEC commands (recursively through scripts) to their text (D-020). */
export function resolveScripts(units: UnitSpec[], root: string): Scripts {
  const out: Scripts = {};
  const pkgs = new Map<string, Record<string, string>>();
  const scriptsAt = (cwd: string) => {
    if (!pkgs.has(cwd)) {
      let s: Record<string, string> = {};
      try {
        s = (JSON.parse(readFileSync(join(root, cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
      } catch {
        // no package.json: nothing resolves
      }
      pkgs.set(cwd, s);
    }
    return pkgs.get(cwd)!;
  };
  const visit = (cmd: string, cwd: string) => {
    const scripts = scriptsAt(cwd);
    for (const [, tool, run, name] of cmd.matchAll(SCRIPT_RE)) {
      let script: string | undefined;
      if (run) script = name;
      else if (tool === 'npm') script = NPM_BARE.has(name!) ? (name === 't' ? 'test' : name) : undefined;
      else if (name! in scripts || name === 'test') script = name;
      if (!script) continue;
      const key = `${cwd}|${script}`;
      if (key in out) continue;
      out[key] = scripts[script] ?? null;
      if (scripts[script]) visit(scripts[script], cwd);
    }
  };
  for (const u of units) if (u.command) visit(u.command, normalize(u.cwd ?? '.'));
  return out;
}

/** Confirmed version = hash of what the gate depends on; Title and Notes are free text (D-021). */
export function specVersion(spec: Pick<Spec, 'units' | 'goal' | 'constraints'>, cfg: FrozenConfig, scripts: Scripts): string {
  const units = spec.units.map((u) => [u.id, u.kind, u.description, u.command ?? null, u.cwd ?? null, u.timeoutMs ?? null]);
  const sorted = Object.keys(scripts).sort().map((k) => [k, scripts[k]]);
  return sha256(JSON.stringify([units, spec.goal, spec.constraints, [cfg.globs, cfg.failCap], sorted])).slice(0, 16);
}

export function skeleton(id: string, title: string): string {
  const fm = stringify({
    id,
    title,
    units: [{ id: 'u1', kind: 'EXEC', description: 'what passing this command proves', command: 'npm test' }],
  });
  return `---\n${fm}---\n## Goal\n\n## Constraints\n\n## Notes\n`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clean(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
