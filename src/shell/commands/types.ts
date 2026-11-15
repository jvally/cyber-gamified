import type { Cred } from '../../vfs/vfs';
import { FsError, normalize } from '../../vfs/vfs';
import type { GameState } from '../state';
import type { Shell } from '../shell';

export interface Ctx {
  state: GameState;
  shell: Shell;
  name: string;
  args: string[];
  stdin: string;
  /** true when stdin comes from a pipe or `<` (otherwise it is the "terminal" and reads as empty) */
  hasStdin: boolean;
  out(s: string): void;
  err(s: string): void;
  cred: Cred;
  /** stdout is the terminal (not a pipe or file) */
  tty: boolean;
  cols: number;
  /** argv strings of every command in the current pipeline (used by ps) */
  pipeline: string[];
}

export interface Help {
  summary: string;
  usage: string;
  options?: [string, string][];
  examples?: [string, string][];
  notes?: string;
}
export interface Command { run(ctx: Ctx): number; help: Help }

export const splitLines = (s: string): string[] => {
  if (s === '') return [];
  const l = s.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
};
export const abs = (ctx: Ctx, p: string): string => normalize(p, ctx.state.cwd);
export const fsMsg = (e: unknown): string => (e instanceof FsError ? e.message : String(e));

export interface OptSpec { flags?: string; values?: string; long?: Record<string, string> }
export interface Opts { f: Record<string, boolean>; v: Record<string, string>; multi: Record<string, string[]>; rest: string[] }

/** getopt-style parsing: -abc, -n5, -n 5, --long, --long=value, `--` ends options, `-` is an operand. */
export function parseOpts(ctx: Ctx, spec: OptSpec, args = ctx.args): Opts | null {
  const o: Opts = { f: {}, v: {}, multi: {}, rest: [] };
  const flags = spec.flags ?? '', values = spec.values ?? '';
  const setVal = (k: string, val: string): void => { o.v[k] = val; (o.multi[k] ??= []).push(val); };
  const fail = (msg: string): null => {
    ctx.err(`${ctx.name}: ${msg}\nTry '${ctx.name} --help' for more information.\n`);
    return null;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { o.rest.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a : a.slice(0, eq);
      const short = spec.long?.[name];
      if (short === undefined) return fail(`unrecognized option '${name}'`);
      if (short === '') continue; // accepted and ignored
      if (values.includes(short)) {
        if (eq >= 0) setVal(short, a.slice(eq + 1));
        else if (i + 1 < args.length) setVal(short, args[++i]);
        else return fail(`option '${name}' requires an argument`);
      } else o.f[short] = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (values.includes(c)) {
          if (j + 1 < a.length) setVal(c, a.slice(j + 1));
          else if (i + 1 < args.length) setVal(c, args[++i]);
          else return fail(`option requires an argument -- '${c}'`);
          break;
        }
        if (!flags.includes(c)) return fail(`invalid option -- '${c}'`);
        o.f[c] = true;
      }
      continue;
    }
    o.rest.push(a);
  }
  return o;
}

/** Read each operand (or stdin when there are none / for `-`). Reports errors GNU-style. */
export function readInputs(ctx: Ctx, files: string[], fmt?: (file: string, msg: string) => string):
  { name: string; content: string }[] & { failed?: boolean } {
  const res: { name: string; content: string }[] & { failed?: boolean } = [];
  for (const f of files.length ? files : ['-']) {
    if (f === '-') { res.push({ name: '-', content: ctx.stdin }); continue; }
    try {
      res.push({ name: f, content: ctx.state.vfs.readFile(abs(ctx, f), ctx.cred) });
    } catch (e) {
      ctx.err((fmt ? fmt(f, fsMsg(e)) : `${ctx.name}: ${f}: ${fsMsg(e)}`) + '\n');
      res.failed = true;
    }
  }
  return res;
}
