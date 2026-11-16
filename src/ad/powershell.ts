// A small PowerShell-like front end: tokenizer, pipeline parser, parameter binding and output formatting.

export class PsError extends Error {}

export class PsDate {
  constructor(public epoch: number) {}
  toString(): string {
    const d = new Date(this.epoch * 1000);
    const h = d.getUTCHours();
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h % 12 || 12}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
  }
}
export type PsValue = string | number | boolean | null | PsDate | PsValue[];
export interface PsObject {
  props: Record<string, PsValue>;
  /** property names shown by default, in order */
  show: string[];
  /** force list formatting (AD objects are always shown as lists) */
  list?: boolean;
  /** the directory object this was read from, for piping into action cmdlets */
  ref?: unknown;
}
export type Item = PsObject | string;

export type Tok =
  | { t: 'word' | 'string' | 'expr' | 'block'; text: string }
  | { t: 'pipe' | 'semi' | 'comma' };

export function tokenize(line: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0, word = '';
  const flush = (): void => { if (word !== '') toks.push({ t: 'word', text: word }); word = ''; };
  const balanced = (open: string, close: string): string => {
    let depth = 0;
    const start = i;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === "'" || c === '"') { const e = line.indexOf(c, i + 1); if (e < 0) break; i = e; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) { i++; return line.slice(start + 1, i - 1); }
    }
    throw new PsError(`Missing closing '${close}' in statement.`);
  };
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') { flush(); i++; continue; }
    if (c === '#' && word === '') break;
    if (c === "'") {
      let s = '';
      for (i++; ; i++) {
        if (i >= line.length) throw new PsError('The string is missing the terminator: \'.');
        if (line[i] === "'") { if (line[i + 1] === "'") { s += "'"; i++; continue; } i++; break; }
        s += line[i];
      }
      flush();
      toks.push({ t: 'string', text: s });
      continue;
    }
    if (c === '"') {
      let s = '';
      for (i++; ; i++) {
        if (i >= line.length) throw new PsError('The string is missing the terminator: ".');
        if (line[i] === '`' && i + 1 < line.length) { s += line[++i]; continue; }
        if (line[i] === '"') { i++; break; }
        s += line[i];
      }
      flush();
      toks.push({ t: 'string', text: s });
      continue;
    }
    if (c === '(') { flush(); toks.push({ t: 'expr', text: balanced('(', ')') }); continue; }
    if (c === '{') { flush(); toks.push({ t: 'block', text: balanced('{', '}') }); continue; }
    if (c === '|') { flush(); toks.push({ t: 'pipe' }); i++; continue; }
    if (c === ';') { flush(); toks.push({ t: 'semi' }); i++; continue; }
    if (c === ',') { flush(); toks.push({ t: 'comma' }); i++; continue; }
    word += c;
    i++;
  }
  flush();
  return toks;
}

export interface Stage { name: string; args: Tok[] }
/** Split a line into statements (`;`), each a pipeline (`|`) of stages. */
export function parse(line: string): Stage[][] {
  const statements: Stage[][] = [];
  let pipeline: Stage[] = [], current: Tok[] = [];
  const endStage = (): void => {
    if (current.length === 0) { if (pipeline.length) throw new PsError('An empty pipe element is not allowed.'); return; }
    const head = current[0];
    if (head.t !== 'word') throw new PsError('Expressions are only allowed as the first element of a pipeline. Start with a cmdlet name.');
    pipeline.push({ name: head.text, args: current.slice(1) });
    current = [];
  };
  for (const tok of tokenize(line)) {
    if (tok.t === 'pipe') { if (current.length === 0) throw new PsError('An empty pipe element is not allowed.'); endStage(); }
    else if (tok.t === 'semi') { endStage(); if (pipeline.length) statements.push(pipeline); pipeline = []; }
    else current.push(tok);
  }
  if (current.length === 0 && pipeline.length) throw new PsError('An empty pipe element is not allowed.');
  endStage();
  if (pipeline.length) statements.push(pipeline);
  return statements;
}

// ---------------------------------------------------------------- parameter binding
export type ParamType = 'string' | 'switch' | 'bool' | 'int' | 'list' | 'yesno';
export interface CmdletSpec {
  params: Record<string, ParamType>;
  positional?: string[];
  mandatory?: string[];
}
/** Parameters every cmdlet accepts and ignores. */
const COMMON: Record<string, boolean> = { confirm: false, verbose: false, passthru: false, force: false, whatif: false, erroraction: true, server: true, credential: true };

export interface SecureString { secure: string }
export type Bound = Record<string, string | number | boolean | string[] | SecureString | undefined>;

function tokValue(tok: Tok): PsValue | SecureString {
  if (tok.t === 'string' || tok.t === 'block') return tok.text;
  if (tok.t === 'expr') {
    if (/ConvertTo-SecureString/i.test(tok.text)) {
      const m = /'((?:[^']|'')*)'|"([^"]*)"/.exec(tok.text);
      if (!m) throw new PsError('ConvertTo-SecureString: provide the password as a quoted string.');
      return { secure: (m[1] ?? m[2]).replace(/''/g, "'") };
    }
    return tok.text;
  }
  if (tok.t !== 'word') throw new PsError('Missing an argument.');
  const w = tok.text;
  if (/^\$true$/i.test(w)) return true;
  if (/^\$false$/i.test(w)) return false;
  if (/^\$null$/i.test(w)) return null;
  if (/^-?\d+$/.test(w)) return parseInt(w, 10);
  return w;
}

export function bind(name: string, args: Tok[], spec: CmdletSpec): Bound {
  const out: Bound = {};
  const positional: (PsValue | SecureString)[] = [];
  const names = Object.keys(spec.params);
  let i = 0;
  const readValue = (): PsValue | SecureString => {
    if (i >= args.length || args[i].t === 'comma') throw new PsError('Missing an argument for a parameter.');
    const items: (PsValue | SecureString)[] = [tokValue(args[i++])];
    while (args[i]?.t === 'comma') { i++; if (i >= args.length) throw new PsError("Missing argument in parameter list."); items.push(tokValue(args[i++])); }
    return items.length === 1 ? items[0] : (items as PsValue[]);
  };
  while (i < args.length) {
    const tok = args[i];
    if (tok.t === 'word' && /^-[A-Za-z]/.test(tok.text)) {
      i++;
      const colon = tok.text.indexOf(':');
      const raw = (colon < 0 ? tok.text : tok.text.slice(0, colon)).slice(1).toLowerCase();
      const inline = colon < 0 ? undefined : tok.text.slice(colon + 1);
      if (inline !== undefined && inline !== '') args.splice(i, 0, { t: 'word', text: inline });
      const exact = names.find((n) => n.toLowerCase() === raw);
      const matches = exact ? [exact] : names.filter((n) => n.toLowerCase().startsWith(raw));
      if (matches.length === 0) {
        const common = Object.keys(COMMON).find((c) => c === raw);
        if (common === undefined) throw new PsError(`A parameter cannot be found that matches parameter name '${tok.text.slice(1).split(':')[0]}'.`);
        if (COMMON[common] || colon >= 0) readValue();
        continue;
      }
      if (matches.length > 1) throw new PsError(`Parameter cannot be processed because the parameter name '${raw}' is ambiguous. Possible matches include: ${matches.map((m) => '-' + m).join(' ')}.`);
      const key = matches[0], type = spec.params[key];
      if (type === 'switch') { out[key] = colon >= 0 ? readValue() !== false : true; continue; }
      out[key] = coerce(key, type, readValue());
      continue;
    }
    positional.push(readValue());
  }
  const slots = (spec.positional ?? []).filter((p) => out[p] === undefined);
  positional.forEach((v, k) => {
    const key = slots[k];
    if (!key) throw new PsError(`A positional parameter cannot be found that accepts argument '${Array.isArray(v) ? v.join(',') : typeof v === 'object' && v ? '...' : v}'.`);
    out[key] = coerce(key, spec.params[key], v);
  });
  void name;
  return out;
}

function coerce(key: string, type: ParamType, v: PsValue | SecureString): Bound[string] {
  if (v !== null && typeof v === 'object' && 'secure' in v) return v;
  if (type === 'list') return (Array.isArray(v) ? v : [v]).map((x) => String(x));
  if (Array.isArray(v)) throw new PsError(`Cannot convert 'System.Object[]' to the type required by parameter '${key}'. Specified method is not supported.`);
  if (type === 'bool') {
    if (typeof v === 'boolean') return v;
    if (v === 0 || v === 1) return v === 1;
    throw new PsError(`Cannot convert value "${v}" to type "System.Boolean". Boolean parameters accept only Boolean values and numbers, such as $True, $False, 1 or 0.`);
  }
  if (type === 'int') {
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (Number.isNaN(n)) throw new PsError(`Cannot convert value "${v}" to type "System.Int32".`);
    return n;
  }
  if (type === 'yesno') {
    const s = String(v).toLowerCase();
    if (s !== 'yes' && s !== 'no') throw new PsError(`Cannot convert value "${v}" for parameter '${key}'. Specify one of the following values: Yes, No.`);
    return s === 'yes';
  }
  return v === null ? '' : String(v);
}

// ---------------------------------------------------------------- filters
type Lookup = (prop: string) => PsValue | undefined;
const cmp = (a: PsValue | undefined, b: PsValue): number => {
  const x = a instanceof PsDate ? a.epoch : a, y = b instanceof PsDate ? b.epoch : b;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'boolean' || typeof y === 'boolean') return x === y ? 0 : 1;
  const s = String(x ?? '').toLowerCase(), t = String(y ?? '').toLowerCase();
  return s < t ? -1 : s > t ? 1 : 0;
};
const likeRe = (pattern: string): RegExp =>
  new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

/** Compile `Prop -eq value [-and|-or ...]` (PowerShell / AD filter subset) into a predicate. */
export function compileFilter(text: string): (get: Lookup) => boolean {
  const src = text.trim();
  if (src === '*') return () => true;
  const toks = tokenize(src.replace(/\$_\./g, ''));
  type Clause = { prop: string; op: string; value: PsValue };
  const clauses: Clause[] = [], joins: string[] = [];
  for (let i = 0; i < toks.length;) {
    const [p, o, v] = [toks[i], toks[i + 1], toks[i + 2]];
    if (!p || p.t !== 'word' || !o || o.t !== 'word' || !v || v.t === 'pipe' || v.t === 'semi' || v.t === 'comma') {
      throw new PsError(`Error parsing query: '${src}'. Expected: Property -operator value.`);
    }
    const op = o.text.toLowerCase();
    if (!['-eq', '-ne', '-like', '-notlike', '-lt', '-le', '-gt', '-ge'].includes(op)) throw new PsError(`Error parsing query: '${src}'. Operator '${o.text}' is not supported.`);
    clauses.push({ prop: p.text, op, value: tokValue(v) as PsValue });
    i += 3;
    const j = toks[i];
    if (!j) break;
    if (j.t !== 'word' || !/^-(and|or)$/i.test(j.text)) throw new PsError(`Error parsing query: '${src}'. Expected -and or -or.`);
    joins.push(j.text.toLowerCase());
    i++;
    if (i >= toks.length) throw new PsError(`Error parsing query: '${src}'.`);
  }
  if (clauses.length === 0) throw new PsError(`Error parsing query: '${src}'.`);
  const test = (c: Clause, get: Lookup): boolean => {
    const actual = get(c.prop);
    if (actual === undefined) return false;
    switch (c.op) {
      case '-eq': return cmp(actual, c.value) === 0;
      case '-ne': return cmp(actual, c.value) !== 0;
      case '-like': return likeRe(String(c.value)).test(String(actual ?? ''));
      case '-notlike': return !likeRe(String(c.value)).test(String(actual ?? ''));
      case '-lt': return actual !== null && cmp(actual, c.value) < 0;
      case '-le': return actual !== null && cmp(actual, c.value) <= 0;
      case '-gt': return actual !== null && cmp(actual, c.value) > 0;
      default: return actual !== null && cmp(actual, c.value) >= 0;
    }
  };
  return (get) => {
    let result = test(clauses[0], get);
    joins.forEach((j, k) => { result = j === '-and' ? result && test(clauses[k + 1], get) : result || test(clauses[k + 1], get); });
    return result;
  };
}
export const sortValues = cmp;

/** Case-insensitive property lookup on a pipeline object. */
export function propOf(o: PsObject, name: string): { key: string; value: PsValue } | undefined {
  const key = Object.keys(o.props).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : { key, value: o.props[key] };
}

// ---------------------------------------------------------------- output formatting
export function show(v: PsValue): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (Array.isArray(v)) return `{${v.map(show).join(', ')}}`;
  return String(v);
}
export function formatList(objs: PsObject[], props?: string[]): string {
  return objs.map((o) => {
    const keys = props ?? o.show;
    const w = Math.max(...keys.map((k) => k.length));
    return '\n' + keys.map((k) => `${k.padEnd(w)} : ${show(propOf(o, k)?.value ?? null)}\n`).join('');
  }).join('') + '\n';
}
export function formatTable(objs: PsObject[], props?: string[]): string {
  const keys = props ?? objs[0].show;
  const rows = objs.map((o) => keys.map((k) => show(propOf(o, k)?.value ?? null)));
  const w = keys.map((k, c) => Math.max(k.length, ...rows.map((r) => r[c].length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(w[i])).join(' ').trimEnd() + '\n';
  return '\n' + line(keys) + line(keys.map((k) => '-'.repeat(k.length))) + rows.map(line).join('') + '\n';
}
/** PowerShell's default view: a table for up to four properties, otherwise a list. */
export function formatDefault(items: Item[]): string {
  let out = '';
  let run: PsObject[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    out += run[0].list || run[0].show.length > 4 ? formatList(run) : formatTable(run);
    run = [];
  };
  for (const it of items) {
    if (typeof it === 'string') { flush(); out += it.endsWith('\n') ? it : it + '\n'; continue; }
    if (run.length && (run[0].show.join() !== it.show.join() || !!run[0].list !== !!it.list)) flush();
    run.push(it);
  }
  flush();
  return out;
}
