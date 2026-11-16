// Parser: tokens -> AST (list of pipelines of simple commands with redirects).
import { Part, ShellSyntaxError, Token, tokenize } from './tokenizer';

export type Word = Part[];
export interface Redirect { op: '>' | '>>' | '<' | '2>' | '2>>' | '2>&1'; target?: Word }
export interface SimpleCommand { argv: Word[]; redirects: Redirect[] }
export interface Pipeline { commands: SimpleCommand[] }
export interface ListItem { pipeline: Pipeline; /** operator joining this item to the previous one */ op: ';' | '&&' | '||' | null }
export type CommandList = ListItem[];

const unexpected = (tok: Token | undefined): ShellSyntaxError =>
  new ShellSyntaxError(`syntax error near unexpected token \`${tok ? (tok.type === 'op' ? tok.op : 'word') : 'newline'}'`);

export function parse(input: string): CommandList {
  const tokens = tokenize(input);
  const list: CommandList = [];
  let pos = 0;
  let joiner: ListItem['op'] = null;

  while (pos < tokens.length) {
    const pipeline: Pipeline = { commands: [] };
    for (;;) {
      const cmd: SimpleCommand = { argv: [], redirects: [] };
      for (;;) {
        const t = tokens[pos];
        if (!t) break;
        if (t.type === 'word') { cmd.argv.push(t.parts); pos++; continue; }
        if (t.op === '2>&1') { cmd.redirects.push({ op: t.op }); pos++; continue; }
        if (t.op === '>' || t.op === '>>' || t.op === '<' || t.op === '2>' || t.op === '2>>') {
          const target = tokens[pos + 1];
          if (!target || target.type !== 'word') throw unexpected(target);
          cmd.redirects.push({ op: t.op, target: target.parts });
          pos += 2;
          continue;
        }
        break;
      }
      if (cmd.argv.length === 0 && cmd.redirects.length === 0) throw unexpected(tokens[pos]);
      pipeline.commands.push(cmd);
      const t = tokens[pos];
      if (t?.type === 'op' && t.op === '|') {
        pos++;
        if (pos >= tokens.length) throw unexpected(undefined);
        continue;
      }
      break;
    }
    list.push({ pipeline, op: joiner });
    const t = tokens[pos];
    if (!t) break;
    if (t.type === 'op' && (t.op === ';' || t.op === '&&' || t.op === '||')) {
      joiner = t.op;
      pos++;
      if (pos >= tokens.length && t.op !== ';') throw unexpected(undefined);
      continue;
    }
    throw unexpected(t);
  }
  return list;
}
