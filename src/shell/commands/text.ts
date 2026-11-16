import { byteLength, cmpC } from '../../vfs/vfs';
import { abs, Command, Ctx, parseOpts, readInputs, splitLines } from './types';

// ---------------------------------------------------------------- sort
interface Key { start: number; end: number; n: boolean; r: boolean; h: boolean; f: boolean; own: boolean }

const leadingNumber = (s: string): number => {
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))/.exec(s);
  return m ? parseFloat(m[1]) : 0;
};
const humanNumber = (s: string): number => {
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))([KMGTP]?)/i.exec(s);
  if (!m) return 0;
  return parseFloat(m[1]) * 1024 ** ' KMGTP'.indexOf(m[2].toUpperCase() || ' ');
};

const sort: Command = {
  run(ctx) {
    const o = parseOpts(ctx, {
      flags: 'nrufhbs', values: 'kt',
      long: { '--numeric-sort': 'n', '--reverse': 'r', '--unique': 'u', '--ignore-case': 'f', '--human-numeric-sort': 'h', '--key': 'k', '--field-separator': 't', '--stable': 's' },
    });
    if (!o) return 2;
    const g = o.f;
    const sep = o.v.t;
    if (sep !== undefined && sep.length !== 1) {
      ctx.err(`sort: multi-character tab '${sep}'\n`);
      return 2;
    }
    const keys: Key[] = [];
    for (const spec of o.multi.k ?? []) {
      const m = /^(\d+)(?:\.\d+)?([bnrhf]*)(?:,(\d+)(?:\.\d+)?([bnrhf]*))?$/.exec(spec);
      if (!m || m[1] === '0') {
        ctx.err(`sort: invalid number at field start: invalid count at start of '${spec}'\n`);
        return 2;
      }
      const fl = m[2] + (m[4] ?? '');
      keys.push({
        start: parseInt(m[1], 10), end: m[3] ? parseInt(m[3], 10) : Infinity, own: fl.replace('b', '') !== '',
        n: fl.includes('n'), r: fl.includes('r'), h: fl.includes('h'), f: fl.includes('f'),
      });
    }
    const inputs = readInputs(ctx, o.rest, (f, msg) => `sort: cannot read: ${f}: ${msg}`);
    if (inputs.failed) return 2;
    const lines = inputs.flatMap((i) => splitLines(i.content));

    const keyText = (line: string, k: Key): string => {
      if (sep !== undefined) return line.split(sep).slice(k.start - 1, k.end).join(sep);
      const fields = line.match(/[ \t]*[^ \t]+/g) ?? [];
      return fields.slice(k.start - 1, k.end).join('');
    };
    const compare = (a: string, b: string, k: { n: boolean; h: boolean; f: boolean }): number => {
      if (k.n) return leadingNumber(a) - leadingNumber(b);
      if (k.h) return humanNumber(a) - humanNumber(b);
      return k.f ? cmpC(a.toUpperCase(), b.toUpperCase()) : cmpC(a, b);
    };
    const global = { n: !!g.n, h: !!g.h, f: !!g.f };
    const keyCmp = (a: string, b: string): number => {
      if (keys.length === 0) {
        const c = compare(a, b, global);
        return g.r ? -c : c;
      }
      for (const k of keys) {
        const c = compare(keyText(a, k), keyText(b, k), k.own ? k : global);
        if (c !== 0) return (k.own ? k.r : g.r) ? -c : c;
      }
      return 0;
    };
    const full = (a: string, b: string): number => {
      const c = keyCmp(a, b);
      if (c !== 0 || g.u || g.s) return c;
      const l = cmpC(a, b);
      return g.r ? -l : l;
    };
    lines.sort(full);
    const out = g.u ? lines.filter((l, i) => i === 0 || keyCmp(lines[i - 1], l) !== 0) : lines;
    ctx.out(out.map((l) => l + '\n').join(''));
    return 0;
  },
  help: {
    summary: 'sort lines of text',
    usage: 'sort [OPTION]... [FILE]...',
    options: [
      ['-n', 'compare by numeric value'], ['-r', 'reverse the result'], ['-u', 'output only the first of equal lines'],
      ['-k N[,M]', 'sort by field N (through M); append n or r per key, e.g. -k2,2nr'], ['-t C', 'use C as the field separator'],
      ['-h', 'compare human-readable numbers (2K, 1G)'], ['-f', 'ignore case'],
    ],
    notes: 'Ordering is byte order (LC_ALL=C): uppercase sorts before lowercase.',
    examples: [['sort ips.txt | uniq -c | sort -rn', 'frequency table, most common first']],
  },
};

// ---------------------------------------------------------------- uniq
const uniq: Command = {
  run(ctx) {
    const o = parseOpts(ctx, { flags: 'cdui', long: { '--count': 'c', '--repeated': 'd', '--unique': 'u', '--ignore-case': 'i' } });
    if (!o) return 1;
    if (o.rest.length > 2) { ctx.err(`uniq: extra operand '${o.rest[2]}'\nTry 'uniq --help' for more information.\n`); return 1; }
    const [input] = readInputs(ctx, o.rest.slice(0, 1));
    if (!input) return 1;
    const groups: { line: string; count: number }[] = [];
    const norm = (s: string): string => (o.f.i ? s.toLowerCase() : s);
    for (const line of splitLines(input.content)) {
      const last = groups[groups.length - 1];
      if (last && norm(last.line) === norm(line)) last.count++;
      else groups.push({ line, count: 1 });
    }
    let out = '';
    for (const grp of groups) {
      if (o.f.d && grp.count < 2) continue;
      if (o.f.u && grp.count > 1) continue;
      out += (o.f.c ? `${String(grp.count).padStart(7)} ` : '') + grp.line + '\n';
    }
    if (o.rest[1]) ctx.state.vfs.writeFile(abs(ctx, o.rest[1]), out, ctx.cred);
    else ctx.out(out);
    return 0;
  },
  help: {
    summary: 'report or omit repeated adjacent lines',
    usage: 'uniq [OPTION]... [INPUT]',
    options: [['-c', 'prefix lines with the number of occurrences'], ['-d', 'only print duplicated lines'], ['-u', 'only print lines that are not repeated'], ['-i', 'ignore case']],
    notes: 'uniq only collapses *adjacent* duplicates, so sort first.',
    examples: [['sort users.txt | uniq -c', 'count occurrences of each line']],
  },
};

// ---------------------------------------------------------------- wc
const wc: Command = {
  run(ctx) {
    const o = parseOpts(ctx, { flags: 'lwcm', long: { '--lines': 'l', '--words': 'w', '--bytes': 'c', '--chars': 'm' } });
    if (!o) return 1;
    const any = o.f.l || o.f.w || o.f.c || o.f.m;
    const cols = { l: any ? !!o.f.l : true, w: any ? !!o.f.w : true, m: !!o.f.m, c: any ? !!o.f.c : true };
    const nCols = Object.values(cols).filter(Boolean).length;
    const rows: { counts: number[]; name?: string }[] = [];
    const total = [0, 0, 0, 0];
    let code = 0, sizeSum = 0;
    for (const f of o.rest.length ? o.rest : ['-']) {
      const [input] = readInputs(ctx, [f]);
      if (!input) { code = 1; continue; }
      const c = input.content;
      const counts = [(c.match(/\n/g) ?? []).length, (c.match(/\S+/g) ?? []).length, [...c].length, byteLength(c)];
      counts.forEach((v, i) => (total[i] += v));
      sizeSum += counts[3];
      rows.push({ counts, name: o.rest.length ? f : undefined });
    }
    if (o.rest.length > 1) rows.push({ counts: total, name: 'total' });
    let width = 1;
    if (o.rest.length === 0 || o.rest.includes('-')) width = nCols > 1 ? 7 : 1;
    else if (rows.length > 1 || nCols > 1) width = String(sizeSum).length;
    for (const r of rows) {
      const nums = [cols.l && r.counts[0], cols.w && r.counts[1], cols.m && r.counts[2], cols.c && r.counts[3]]
        .filter((v): v is number => v !== false).map((v) => String(v).padStart(width));
      ctx.out(nums.join(' ') + (r.name !== undefined ? ` ${r.name}` : '') + '\n');
    }
    return code;
  },
  help: {
    summary: 'count lines, words and bytes',
    usage: 'wc [-lwcm] [FILE]...',
    options: [['-l', 'lines'], ['-w', 'words'], ['-c', 'bytes'], ['-m', 'characters']],
    examples: [['grep "Failed password" auth.log | wc -l', 'how many failed logins?']],
  },
};

// ---------------------------------------------------------------- cut
function parseList(list: string): [number, number][] | string {
  const ranges: [number, number][] = [];
  for (const part of list.split(',')) {
    const m = /^(\d*)(-?)(\d*)$/.exec(part);
    if (!m || (m[1] === '' && m[3] === '')) return 'invalid byte, character or field list';
    const lo = m[1] === '' ? 1 : parseInt(m[1], 10);
    const hi = m[2] === '' ? lo : m[3] === '' ? Infinity : parseInt(m[3], 10);
    if (lo === 0 || hi === 0) return 'fields are numbered from 1';
    if (hi < lo) return 'invalid decreasing range';
    ranges.push([lo, hi]);
  }
  return ranges;
}

const cut: Command = {
  run(ctx) {
    const o = parseOpts(ctx, { flags: 's', values: 'dfcb', long: { '--delimiter': 'd', '--fields': 'f', '--characters': 'c', '--bytes': 'b', '--only-delimited': 's' } });
    if (!o) return 1;
    const fail = (msg: string): number => {
      ctx.err(`cut: ${msg}\nTry 'cut --help' for more information.\n`);
      return 1;
    };
    const listSpec = o.v.f ?? o.v.c ?? o.v.b;
    if (listSpec === undefined) return fail('you must specify a list of bytes, characters, or fields');
    if ([o.v.f, o.v.c, o.v.b].filter((v) => v !== undefined).length > 1) return fail('only one list may be specified');
    const byField = o.v.f !== undefined;
    if (o.v.d !== undefined && !byField) return fail('an input delimiter may be specified only when operating on fields');
    const delim = o.v.d ?? '\t';
    if ([...delim].length !== 1) return fail('the delimiter must be a single character');
    const ranges = parseList(listSpec);
    if (typeof ranges === 'string') return fail(byField || !ranges.startsWith('fields') ? ranges : 'byte/character positions are numbered from 1');
    const pick = (i: number): boolean => ranges.some(([lo, hi]) => i >= lo && i <= hi);
    const inputs = readInputs(ctx, o.rest);
    for (const { content } of inputs) {
      for (const line of splitLines(content)) {
        if (!byField) { ctx.out([...line].filter((_, i) => pick(i + 1)).join('') + '\n'); continue; }
        if (!line.includes(delim)) { if (!o.f.s) ctx.out(line + '\n'); continue; }
        ctx.out(line.split(delim).filter((_, i) => pick(i + 1)).join(delim) + '\n');
      }
    }
    return inputs.failed ? 1 : 0;
  },
  help: {
    summary: 'remove sections from each line',
    usage: 'cut -f LIST [-d DELIM] [FILE]...   |   cut -c LIST [FILE]...',
    options: [['-d C', 'field delimiter (default: TAB)'], ['-f LIST', 'select fields, e.g. 1,3 or 2-4 or 5-'], ['-c LIST', 'select character positions'], ['-s', 'skip lines without the delimiter']],
    notes: 'Each single delimiter starts a new field, so repeated spaces create empty fields.',
    examples: [["cut -d: -f1,7 /etc/passwd", 'user names and their shells'], ["cut -d' ' -f11 failed.txt", 'the 11th space-separated field']],
  },
};

// ---------------------------------------------------------------- echo
const ESC: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
const echo: Command = {
  run(ctx: Ctx) {
    const args = [...ctx.args];
    let newline = true, escapes = false;
    while (args.length && /^-[neE]+$/.test(args[0])) {
      const fl = args.shift()!;
      if (fl.includes('n')) newline = false;
      if (fl.includes('e')) escapes = true;
      if (fl.includes('E')) escapes = false;
    }
    let text = args.join(' ');
    if (escapes) {
      let stop = false;
      text = text.replace(/\\(0[0-7]{1,3}|x[0-9a-fA-F]{1,2}|c[\s\S]*|.)/g, (all, e: string) => {
        if (e[0] === 'c') { stop = true; return ''; }
        if (e[0] === '0' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 8));
        if (e[0] === '0') return '\0';
        if (e[0] === 'x' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
        return ESC[e] ?? all;
      });
      if (stop) newline = false;
    }
    ctx.out(text + (newline ? '\n' : ''));
    return 0;
  },
  help: {
    summary: 'display a line of text',
    usage: 'echo [-n] [-e] [STRING]...',
    options: [['-n', 'no trailing newline'], ['-e', 'interpret backslash escapes such as \\n and \\t']],
    examples: [['echo "aGVsbG8=" | base64 -d', 'feed a string into another command']],
  },
};

export const text = { sort, uniq, wc, cut, echo };
