// Word expansion: tilde, $VAR, field splitting, pathname globbing (in that order, like bash).
import { normalize } from '../vfs/vfs';
import { globToRegex, hasGlob, unescapeGlob } from './glob';
import type { Word } from './parser';
import type { GameState } from './state';

interface Seg { text: string; quoted: boolean }

function expandVars(text: string, state: GameState): string {
  return text.replace(/\$(\?|[A-Za-z_]\w*|\{[A-Za-z_]\w*\})/g, (_, name: string) => {
    if (name === '?') return String(state.lastExit);
    return state.env[name.replace(/[{}]/g, '')] ?? '';
  });
}

export function expandWord(word: Word, state: GameState): string[] {
  // 1+2: tilde and variables
  const segs: Seg[] = word.map((p, i) => {
    if (p.q === 'single') return { text: p.text, quoted: true };
    let text = p.text;
    if (p.q === 'none' && i === 0 && ((text === '~' && word.length === 1) || text.startsWith('~/'))) {
      return { text: state.env.HOME + expandVars(text.slice(1), state), quoted: false };
    }
    text = expandVars(text, state);
    return { text, quoted: p.q === 'double' };
  });

  // 3: field splitting on unquoted whitespace (only arises from variable expansion)
  const fields: Seg[][] = [[]];
  let sawQuoted = false;
  for (const s of segs) {
    if (s.quoted) { fields[fields.length - 1].push(s); sawQuoted = true; continue; }
    const pieces = s.text.split(/[ \t\n]+/);
    pieces.forEach((piece, i) => {
      if (i > 0) fields.push([]);
      if (piece !== '') fields[fields.length - 1].push({ text: piece, quoted: false });
    });
  }
  const nonEmpty = fields.filter((f) => f.length > 0);
  if (nonEmpty.length === 0) return sawQuoted ? [''] : [];

  // 4: globbing
  const out: string[] = [];
  for (const f of nonEmpty) {
    const pattern = f.map((s) => (s.quoted ? s.text.replace(/[\\*?[\]]/g, '\\$&') : s.text.replace(/\\/g, '\\\\'))).join('');
    const literal = f.map((s) => s.text).join('');
    if (!f.some((s) => !s.quoted && /[*?[]/.test(s.text))) { out.push(literal); continue; }
    const matches = glob(pattern, state);
    if (matches.length) out.push(...matches); else out.push(literal);
  }
  return out;
}

function glob(pattern: string, state: GameState): string[] {
  const abs = pattern.startsWith('/');
  const comps = pattern.split('/').filter((c) => c !== '');
  const cred = state.users.cred(state.user);
  let acc: string[] = [abs ? '/' : ''];
  for (const comp of comps) {
    const next: string[] = [];
    for (const base of acc) {
      const join = (name: string): string => (base === '' ? name : base.endsWith('/') ? base + name : `${base}/${name}`);
      const dirAbs = normalize(base === '' ? '.' : base, state.cwd);
      if (!hasGlob(comp)) {
        const name = unescapeGlob(comp);
        if (state.vfs.tryGet(normalize(join(name), state.cwd), cred)) next.push(join(name));
        continue;
      }
      let names: string[];
      try { names = state.vfs.list(dirAbs, cred); } catch { continue; }
      const re = globToRegex(comp);
      for (const n of names) {
        if (n.startsWith('.') && !comp.startsWith('.')) continue;
        if (re.test(n)) next.push(join(n));
      }
    }
    acc = next;
    if (acc.length === 0) break;
  }
  return acc;
}
