import { can, cmpC, nodeSize, R, VNode, X } from '../../vfs/vfs';
import { applyMode } from '../../vfs/perms';
import { globToRegex } from '../glob';
import { abs, Command, Ctx, fsMsg } from './types';

interface Entry { path: string; abs: string; node: VNode; depth: number }
type Pred = (e: Entry) => boolean;
class FindError extends Error {}

const numTest = (spec: string, what: string): ((v: number) => boolean) => {
  const m = /^([+-]?)(\d+)$/.exec(spec);
  if (!m) throw new FindError(`invalid argument '${spec}' to '${what}'`);
  const n = parseInt(m[2], 10);
  return m[1] === '+' ? (v) => v > n : m[1] === '-' ? (v) => v < n : (v) => v === n;
};

function run(ctx: Ctx): number {
  const { vfs, users } = ctx.state;
  const args = ctx.args;
  let i = 0;
  const paths: string[] = [];
  while (i < args.length && !args[i].startsWith('-') && args[i] !== '!' && args[i] !== '(') paths.push(args[i++]);
  if (paths.length === 0) paths.push('.');

  let maxDepth = Infinity, minDepth = 0, hasAction = false, depthFirst = false, code = 0;
  const pending: { argv: string[]; files: string[] }[] = [];

  const need = (what: string): string => {
    if (i >= args.length) throw new FindError(`missing argument to \`${what}'`);
    return args[i++];
  };
  const primary = (): Pred => {
    const t = args[i++];
    switch (t) {
      case '(': { const p = orExpr(); if (args[i++] !== ')') throw new FindError("invalid expression; expected to find a ')' but didn't see one"); return p; }
      case '!': case '-not': { const p = primary(); return (e) => !p(e); }
      case '-name': case '-iname': {
        const re = globToRegex(need(t), t === '-iname' ? 'i' : '');
        return (e) => re.test(e.abs === '/' ? '/' : e.abs.slice(e.abs.lastIndexOf('/') + 1));
      }
      case '-path': {
        const re = new RegExp(globToRegex(need(t)).source.replace(/\[\^\/\]/g, '[\\s\\S]'));
        return (e) => re.test(e.path);
      }
      case '-type': {
        const types = need(t).split(',');
        if (types.some((x) => x !== 'f' && x !== 'd')) throw new FindError(`Unknown argument to -type: ${types.find((x) => x !== 'f' && x !== 'd')}`);
        return (e) => types.includes(e.node.type === 'dir' ? 'd' : 'f');
      }
      case '-perm': {
        const spec = need(t);
        const kind = spec[0] === '-' ? 'all' : spec[0] === '/' ? 'any' : 'exact';
        const bits = applyMode(kind === 'exact' ? spec : spec.slice(1), 0, false, 0);
        if (bits === null) throw new FindError(`invalid mode '${spec}'`);
        return (e) => kind === 'all' ? (e.node.mode & bits) === bits : kind === 'any' ? (e.node.mode & bits) !== 0 || bits === 0 : (e.node.mode & 0o7777) === bits;
      }
      case '-user': {
        const u = need(t);
        const name = /^\d+$/.test(u) ? users.byUid(parseInt(u, 10))?.name : users.get(u)?.name;
        if (!name) throw new FindError(`'${u}' is not the name of a known user`);
        return (e) => e.node.owner === name;
      }
      case '-group': {
        const grp = need(t);
        if (!users.hasGroup(grp)) throw new FindError(`'${grp}' is not the name of an existing group`);
        return (e) => e.node.group === grp;
      }
      case '-mtime': { const test = numTest(need(t), t); return (e) => test(Math.floor((vfs.now - e.node.mtime) / 86400)); }
      case '-mmin': { const test = numTest(need(t), t); return (e) => test(Math.ceil((vfs.now - e.node.mtime) / 60)); }
      case '-newer': {
        const ref = need(t);
        const node = vfs.tryGet(abs(ctx, ref), ctx.cred);
        if (!node) throw new FindError(`'${ref}': No such file or directory`);
        return (e) => e.node.mtime > node.mtime;
      }
      case '-size': {
        const spec = need(t);
        const m = /^([+-]?\d+)([cwbkMG]?)$/.exec(spec);
        if (!m) throw new FindError(`invalid argument '${spec}' to '-size'`);
        const unit = { c: 1, w: 2, b: 512, '': 512, k: 1024, M: 1048576, G: 1073741824 }[m[2]]!;
        const test = numTest(m[1], t);
        return (e) => test(Math.ceil(nodeSize(e.node) / unit));
      }
      case '-empty': return (e) => (e.node.type === 'dir' ? e.node.children.size === 0 : e.node.content === '');
      case '-readable': return (e) => can(e.node, ctx.cred, R);
      case '-writable': return (e) => can(e.node, ctx.cred, 2);
      case '-executable': return (e) => can(e.node, ctx.cred, X) && (e.node.mode & 0o111) !== 0;
      case '-maxdepth': maxDepth = parseInt(need(t), 10); return () => true;
      case '-mindepth': minDepth = parseInt(need(t), 10); return () => true;
      case '-print': hasAction = true; return (e) => { ctx.out(e.path + '\n'); return true; };
      case '-delete':
        hasAction = depthFirst = true;
        return (e) => {
          try { vfs.remove(e.abs, ctx.cred); return true; } catch (err) {
            ctx.err(`find: cannot delete '${e.path}': ${fsMsg(err)}\n`);
            code = 1;
            return false;
          }
        };
      case '-exec': {
        hasAction = true;
        const argv: string[] = [];
        while (i < args.length && args[i] !== ';' && args[i] !== '+') argv.push(args[i++]);
        if (i >= args.length) throw new FindError("missing argument to `-exec'");
        const batch = args[i++] === '+';
        if (argv.length === 0) throw new FindError("missing argument to `-exec'");
        const exec = (files: string[]): boolean => {
          const full = batch && argv[argv.length - 1] === '{}' ? [...argv.slice(0, -1), ...files] : argv.map((a) => a.replace(/\{\}/g, files[0]));
          const rc = ctx.shell.dispatch(full, { stdin: '', hasStdin: false, out: ctx.out, err: ctx.err, tty: false, cols: ctx.cols, pipeline: ctx.pipeline }, ctx.cred);
          return rc === 0;
        };
        if (batch) {
          const slot = { argv, files: [] as string[] };
          pending.push(slot);
          (slot as { run?: () => void }).run = () => { if (slot.files.length) exec(slot.files); };
          return (e) => { slot.files.push(e.path); return true; };
        }
        return (e) => exec([e.path]);
      }
      default:
        if (t.startsWith('-')) throw new FindError(`unknown predicate \`${t}'`);
        throw new FindError(`paths must precede expression: '${t}'`);
    }
  };
  const andExpr = (): Pred => {
    const parts: Pred[] = [];
    while (i < args.length && args[i] !== '-o' && args[i] !== '-or' && args[i] !== ')') {
      if (args[i] === '-a' || args[i] === '-and') { i++; continue; }
      parts.push(primary());
    }
    return (e) => parts.every((p) => p(e));
  };
  const orExpr = (): Pred => {
    const parts: Pred[] = [andExpr()];
    while (args[i] === '-o' || args[i] === '-or') { i++; parts.push(andExpr()); }
    return (e) => parts.some((p) => p(e));
  };

  let expr: Pred;
  try {
    expr = orExpr();
    if (i < args.length) throw new FindError("invalid expression; you have too many ')'");
  } catch (e) {
    if (!(e instanceof FindError)) throw e;
    ctx.err(`find: ${e.message}\n`);
    return 1;
  }

  const visit = (entry: Entry): void => {
    const evaluate = (): void => {
      if (entry.depth < minDepth) return;
      if (expr(entry) && !hasAction) ctx.out(entry.path + '\n');
    };
    if (!depthFirst) evaluate();
    if (entry.node.type === 'dir' && entry.depth < maxDepth) {
      if (!can(entry.node, ctx.cred, R) || !can(entry.node, ctx.cred, X)) {
        ctx.err(`find: '${entry.path}': Permission denied\n`);
        code = 1;
      } else {
        for (const [name, node] of [...entry.node.children].sort((a, b) => cmpC(a[0], b[0]))) {
          visit({
            path: entry.path.endsWith('/') ? entry.path + name : `${entry.path}/${name}`,
            abs: `${entry.abs === '/' ? '' : entry.abs}/${name}`, node, depth: entry.depth + 1,
          });
        }
      }
    }
    if (depthFirst) evaluate();
  };
  for (const p of paths) {
    try {
      visit({ path: p, abs: abs(ctx, p), node: vfs.get(abs(ctx, p), ctx.cred), depth: 0 });
    } catch (e) {
      ctx.err(`find: '${p}': ${fsMsg(e)}\n`);
      code = 1;
    }
  }
  for (const slot of pending) (slot as { run?: () => void }).run?.();
  return code;
}

export const find: Command = {
  run,
  help: {
    summary: 'search for files in a directory tree',
    usage: 'find [PATH...] [EXPRESSION]',
    options: [
      ['-name PATTERN', 'base name matches glob (quote it!); -iname ignores case'],
      ['-type f|d', 'regular file or directory'],
      ['-perm MODE', 'exactly MODE; -perm -MODE = all those bits set; -perm /MODE = any of them'],
      ['-user NAME, -group NAME', 'owned by user / group'],
      ['-mtime N, -mmin N', 'modified N days / minutes ago (+N more than, -N less than)'],
      ['-newer FILE', 'modified more recently than FILE'],
      ['-size N[ckMG]', 'size test, with + / - prefixes'],
      ['-maxdepth N, -mindepth N', 'limit recursion depth'],
      ['-empty, -readable, -writable, -executable', 'other tests'],
      ['! EXPR, EXPR -o EXPR, \\( \\)', 'negation, OR, grouping (AND is implicit)'],
      ['-print, -delete, -exec CMD {} \;', 'actions (default is -print)'],
    ],
    notes: 'Results are listed in sorted order (real find uses on-disk order).',
    examples: [
      ['find / -name ".env" 2>/dev/null', 'find stray secrets files, hiding permission errors'],
      ['find / -perm -4000 -type f', 'list SUID binaries'],
      ['find /etc -mtime -1', 'what changed under /etc in the last day?'],
    ],
  },
};
