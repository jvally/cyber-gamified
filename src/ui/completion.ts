// Tab completion for command names, option flags and paths in the virtual filesystem.
import { normalize } from '../vfs/vfs';
import type { GameState } from '../shell/state';
import type { Command } from '../shell/commands/types';

export interface Completion { line: string; cursor: number; candidates: string[] }

const escape = (s: string): string => s.replace(/([ '"\\$*?()[\]|&;<>#!`])/g, '\\$1');
const commonPrefix = (xs: string[]): string => {
  let p = xs[0] ?? '';
  for (const x of xs) while (!x.startsWith(p)) p = p.slice(0, -1);
  return p;
};

export function complete(line: string, cursor: number, state: GameState, commands: Record<string, Command>): Completion {
  const none: Completion = { line, cursor, candidates: [] };
  const head = line.slice(0, cursor);
  // start of the word under the cursor (a backslash-escaped space does not end a word)
  let start = cursor;
  while (start > 0 && !(/[\s|;&<>]/.test(head[start - 1]) && head[start - 2] !== '\\')) start--;
  const word = head.slice(start).replace(/\\(.)/g, '$1');
  // words of the current simple command, before the one being completed
  const segment = head.slice(0, start).split(/\|\||&&|[|;]/).pop() ?? '';
  const prior = segment.trim().split(/\s+/).filter(Boolean);
  const afterRedirect = /[<>]\s*$/.test(head.slice(0, start));
  if (prior[0] === 'sudo') prior.shift();
  const cmdName = prior[0];
  const wantCommand = !afterRedirect && (prior.length === 0 || ((cmdName === 'help' || cmdName === 'man') && prior.length === 1));

  let matches: { text: string; shown: string; final: boolean }[];
  if (wantCommand) {
    matches = Object.keys(commands).concat(prior.length === 0 ? ['sudo'] : []).filter((n) => n.startsWith(word)).sort()
      .map((n) => ({ text: n, shown: n, final: true }));
  } else if (word.startsWith('-') && !afterRedirect) {
    const flags = new Set<string>();
    for (const [spec] of commands[cmdName]?.help.options ?? []) {
      for (const tok of spec.split(/[\s,/]+/)) if (/^--?[A-Za-z0-9]/.test(tok)) flags.add(tok.replace(/[=[].*$/, ''));
    }
    matches = [...flags].filter((f) => f.startsWith(word)).sort().map((f) => ({ text: f, shown: f, final: true }));
  } else {
    const slash = word.lastIndexOf('/');
    const dirPart = word.slice(0, slash + 1), base = word.slice(slash + 1);
    const expanded = dirPart === '~/' || dirPart.startsWith('~/') ? state.env.HOME + dirPart.slice(1) : dirPart;
    const dirAbs = normalize(expanded === '' ? '.' : expanded, state.cwd);
    let names: string[];
    try { names = state.vfs.list(dirAbs, state.users.cred(state.user)); } catch { return none; }
    matches = names
      .filter((n) => n.startsWith(base) && (base.startsWith('.') || !n.startsWith('.')))
      .map((n) => ({ n, isDir: state.vfs.isDir(`${dirAbs === '/' ? '' : dirAbs}/${n}`) }))
      .filter((m) => m.isDir || cmdName !== 'cd')
      .map((m) => ({ text: dirPart + m.n + (m.isDir ? '/' : ''), shown: m.n + (m.isDir ? '/' : ''), final: !m.isDir }));
  }
  if (matches.length === 0) return none;

  const single = matches.length === 1;
  const replacement = single ? matches[0].text : commonPrefix(matches.map((m) => m.text));
  if (!single && replacement.length <= word.length) return { ...none, candidates: matches.map((m) => m.shown) };
  const inserted = escape(replacement).replace(/^\\~\//, '~/') + (single && matches[0].final ? ' ' : '');
  const newLine = line.slice(0, start) + inserted + line.slice(cursor);
  return { line: newLine, cursor: start + inserted.length, candidates: single ? [] : matches.map((m) => m.shown) };
}
