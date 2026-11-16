import { abs, Command, Ctx, fsMsg, parseOpts, splitLines } from './types';
import { escapeRe } from '../glob';

const POSIX: Record<string, string> = {
  digit: '0-9', alpha: 'a-zA-Z', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s',
  xdigit: '0-9a-fA-F', punct: '!-\\/:-@\\[-`{-~', blank: ' \\t', word: '\\w',
};

/** Translate a POSIX bracket expression starting at src[i] === '['. Returns [jsSource, nextIndex] or null. */
function bracket(src: string, i: number): [string, number] | null {
  let j = i + 1, out = '[';
  if (src[j] === '^') { out += '^'; j++; }
  if (src[j] === ']') { out += '\\]'; j++; }
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === ']') return [out + ']', j + 1];
    if (c === '[' && src[j + 1] === ':') {
      const end = src.indexOf(':]', j + 2);
      const cls = end > 0 ? POSIX[src.slice(j + 2, end)] : undefined;
      if (cls === undefined) return null;
      out += cls;
      j = end + 1;
    } else if (c === '\\' || c === '[') out += '\\' + c;
    else out += c;
  }
  return null;
}

/** Convert a grep pattern (BRE, ERE or fixed) to a JS regex source. Throws on invalid patterns. */
export function grepSource(pattern: string, mode: 'bre' | 'ere' | 'fixed' | 'perl'): string {
  if (mode === 'fixed') return escapeRe(pattern);
  if (mode === 'perl') return pattern;
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '[') {
      const b = bracket(pattern, i);
      if (!b) throw new Error('Invalid regular expression');
      out += b[0];
      i = b[1] - 1;
    } else if (c === '\\') {
      const n = pattern[++i];
      if (n === undefined) throw new Error('Trailing backslash');
      if (n === '<' || n === '>') out += '\\b';
      else if ('wWsSbB'.includes(n) || /\d/.test(n)) out += '\\' + n;
      else if (mode === 'bre' && '(){}|+?'.includes(n)) out += n;
      else out += escapeRe(n);
    } else if (mode === 'bre' && '(){}|+?'.includes(c)) out += '\\' + c;
    else if (mode === 'bre' && c === '*' && (i === 0 || out.endsWith('(') || out.endsWith('|') || out === '^')) out += '\\*';
    else if (c === '/') out += '\\/';
    else out += c;
  }
  return out;
}

function run(ctx: Ctx): number {
  const o = parseOpts(ctx, {
    flags: 'ivcnrRlLoEFPwxhHqs', values: 'emABC',
    long: {
      '--ignore-case': 'i', '--invert-match': 'v', '--count': 'c', '--line-number': 'n', '--recursive': 'r',
      '--files-with-matches': 'l', '--only-matching': 'o', '--extended-regexp': 'E', '--fixed-strings': 'F',
      '--word-regexp': 'w', '--quiet': 'q', '--color': '', '--colour': '', '--regexp': 'e', '--max-count': 'm',
    },
  });
  if (!o) return 2;
  const f = o.f;
  let patterns = o.multi.e;
  const rest = [...o.rest];
  if (!patterns) {
    if (rest.length === 0) {
      ctx.err("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n");
      return 2;
    }
    patterns = [rest.shift()!];
  }
  let re: RegExp;
  try {
    const mode = f.F ? 'fixed' : f.P ? 'perl' : f.E ? 'ere' : 'bre';
    let src = patterns.flatMap((p) => p.split('\n')).map((p) => `(?:${grepSource(p, mode)})`).join('|');
    if (f.x) src = `^(?:${src})$`;
    else if (f.w) src = `(?<![\\w])(?:${src})(?![\\w])`;
    re = new RegExp(src, 'g' + (f.i ? 'i' : ''));
  } catch (e) {
    ctx.err(`grep: ${(e as Error).message.replace(/^Invalid regular expression: .*?: /, '')}\n`);
    return 2;
  }
  const num = (k: string): number => (o.v[k] !== undefined ? parseInt(o.v[k], 10) : 0);
  const after = num('A') || num('C'), before = num('B') || num('C');
  const maxCount = o.v.m !== undefined ? parseInt(o.v.m, 10) : Infinity;
  const recursive = f.r || f.R;
  const { vfs } = ctx.state;
  let error = false, matchedAny = false;

  // Collect inputs
  const inputs: { label: string; content: string }[] = [];
  const walk = (label: string, path: string): void => {
    let names: string[];
    try { names = vfs.list(path, ctx.cred); } catch (e) {
      if (!f.s) ctx.err(`grep: ${label}: ${fsMsg(e)}\n`);
      error = true;
      return;
    }
    for (const n of names) {
      const childLabel = label === '' ? n : label.endsWith('/') ? label + n : `${label}/${n}`;
      const childPath = `${path === '/' ? '' : path}/${n}`;
      const node = vfs.get(childPath);
      if (node.type === 'dir') walk(childLabel, childPath);
      else {
        try { inputs.push({ label: childLabel, content: vfs.readFile(childPath, ctx.cred) }); } catch (e) {
          if (!f.s) ctx.err(`grep: ${childLabel}: ${fsMsg(e)}\n`);
          error = true;
        }
      }
    }
  };
  let sawDir = false;
  if (rest.length === 0) {
    if (recursive) { sawDir = true; walk('', ctx.state.cwd); }
    else inputs.push({ label: '(standard input)', content: ctx.stdin });
  }
  for (const t of rest) {
    if (t === '-') { inputs.push({ label: '(standard input)', content: ctx.stdin }); continue; }
    try {
      const node = vfs.get(abs(ctx, t), ctx.cred);
      if (node.type === 'dir') {
        if (recursive) { sawDir = true; walk(t, abs(ctx, t)); }
        else { if (!f.s) ctx.err(`grep: ${t}: Is a directory\n`); error = true; }
      } else inputs.push({ label: t, content: vfs.readFile(abs(ctx, t), ctx.cred) });
    } catch (e) {
      if (!f.s) ctx.err(`grep: ${t}: ${fsMsg(e)}\n`);
      error = true;
    }
  }
  const withName = f.H || (!f.h && (rest.length > 1 || sawDir));

  for (const { label, content } of inputs) {
    const lines = splitLines(content);
    const hits: number[] = [];
    for (let i = 0; i < lines.length && hits.length < maxCount; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i]) !== !!f.v) hits.push(i);
    }
    if (hits.length) matchedAny = true;
    if (f.q) { if (matchedAny) return 0; continue; }
    const prefix = withName ? `${label}:` : '';
    if (f.l || f.L) {
      if ((hits.length > 0) === !!f.l) ctx.out(label + '\n');
      continue;
    }
    if (f.c) { ctx.out(`${prefix}${hits.length}\n`); continue; }
    if (f.o && !f.v) {
      for (const i of hits) {
        re.lastIndex = 0;
        for (const m of lines[i].matchAll(re)) {
          if (m[0] !== '') ctx.out(`${prefix}${f.n ? `${i + 1}:` : ''}${m[0]}\n`);
        }
      }
      continue;
    }
    if (!after && !before) {
      for (const i of hits) ctx.out(`${prefix}${f.n ? `${i + 1}:` : ''}${lines[i]}\n`);
      continue;
    }
    const hitSet = new Set(hits);
    let lastPrinted = -2;
    for (let i = 0; i < lines.length; i++) {
      const near = hits.some((h) => i >= h - before && i <= h + after);
      if (!near) continue;
      if (lastPrinted >= 0 && i > lastPrinted + 1) ctx.out('--\n');
      const sep = hitSet.has(i) ? ':' : '-';
      ctx.out(`${withName ? label + sep : ''}${f.n ? `${i + 1}${sep}` : ''}${lines[i]}\n`);
      lastPrinted = i;
    }
  }
  if (error && !(f.q && matchedAny)) return 2;
  return matchedAny ? 0 : 1;
}

export const grep: Command = {
  run,
  help: {
    summary: 'print lines that match a pattern',
    usage: 'grep [OPTION]... PATTERN [FILE]...',
    options: [
      ['-i', 'ignore case'], ['-v', 'select non-matching lines'], ['-c', 'print only a count of matching lines'],
      ['-n', 'prefix each line with its line number'], ['-r, -R', 'search directories recursively'],
      ['-l / -L', 'print only names of files with / without matches'], ['-o', 'print only the matched part of each line'],
      ['-E', 'extended regex: + ? | ( ) { } are operators'], ['-F', 'pattern is a fixed string, not a regex'],
      ['-w / -x', 'match whole words / whole lines'], ['-h / -H', 'hide / always show file names'],
      ['-A N, -B N, -C N', 'print N lines of context after / before / around matches'],
      ['-m N', 'stop after N matching lines'], ['-q', 'quiet; exit status only'], ['-e PATTERN', 'give a pattern explicitly (repeatable)'],
    ],
    notes: 'Default patterns are basic regexes (BRE): write \\| \\+ \\? \\( \\) for operators, or use -E. Exit status: 0 match, 1 no match, 2 error.',
    examples: [
      ['grep -c "Failed password" /var/log/auth.log', 'count failed logins'],
      ['grep -rn "SECRET" /var/www', 'hunt for leaked secrets recursively'],
      ["grep -oE '([0-9]{1,3}\\.){3}[0-9]{1,3}' auth.log", 'extract every IPv4 address'],
    ],
  },
};
