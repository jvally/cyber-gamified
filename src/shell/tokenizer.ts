// Tokenizer: turns a command line into words (with per-part quoting info) and operators.

export type Quote = 'none' | 'double' | 'single';
export interface Part { text: string; q: Quote }
export type Op = '|' | '>' | '>>' | '<' | '2>' | '2>>' | '2>&1' | ';' | '&&' | '||';
export type Token = { type: 'word'; parts: Part[] } | { type: 'op'; op: Op };

export class ShellSyntaxError extends Error {}
const unsupported = (what: string): ShellSyntaxError =>
  new ShellSyntaxError(`${what} is not supported in this simulator`);

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let parts: Part[] | null = null;
  let i = 0;
  const add = (text: string, q: Quote): void => {
    parts ??= [];
    const last = parts[parts.length - 1];
    if (last && last.q === q) last.text += text;
    else parts.push({ text, q });
  };
  const flush = (): void => {
    if (parts) tokens.push({ type: 'word', parts });
    parts = null;
  };
  const op = (o: Op, len: number): void => { flush(); tokens.push({ type: 'op', op: o }); i += len; };

  while (i < input.length) {
    const c = input[i];
    const rest = input.slice(i);
    if (c === ' ' || c === '\t' || c === '\n') { flush(); i++; continue; }
    if (c === '#' && !parts) break;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new ShellSyntaxError("unexpected EOF while looking for matching `''");
      add(input.slice(i + 1, end), 'single');
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      add('', 'double');
      for (;;) {
        if (i >= input.length) throw new ShellSyntaxError('unexpected EOF while looking for matching `"\'');
        const d = input[i];
        if (d === '"') { i++; break; }
        if (d === '`' || (d === '$' && input[i + 1] === '(')) throw unsupported('command substitution');
        if (d === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) {
          add(input[i + 1], 'single');
          i += 2;
          continue;
        }
        add(d, 'double');
        i++;
      }
      continue;
    }
    if (c === '\\') {
      if (i + 1 < input.length) add(input[i + 1], 'single');
      i += 2;
      continue;
    }
    if (c === '`' || rest.startsWith('$(')) throw unsupported('command substitution');
    if (c === '(' || c === ')') throw unsupported('subshell syntax');
    if (rest.startsWith('<<')) throw unsupported('here-document syntax');
    if (!parts && rest.startsWith('2>&1')) { op('2>&1', 4); continue; }
    if (!parts && rest.startsWith('2>>')) { op('2>>', 3); continue; }
    if (!parts && rest.startsWith('2>')) { op('2>', 2); continue; }
    if (rest.startsWith('>&') || rest.startsWith('&>')) throw unsupported('this redirection form');
    if (rest.startsWith('||')) { op('||', 2); continue; }
    if (rest.startsWith('&&')) { op('&&', 2); continue; }
    if (rest.startsWith('>>')) { op('>>', 2); continue; }
    if (c === '&') throw unsupported('running jobs in the background (&)');
    if (c === '|') { op('|', 1); continue; }
    if (c === '>') { op('>', 1); continue; }
    if (c === '<') { op('<', 1); continue; }
    if (c === ';') { op(';', 1); continue; }
    add(c, 'none');
    i++;
  }
  flush();
  return tokens;
}
