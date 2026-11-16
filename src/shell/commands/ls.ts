import { can, cmpC, nodeSize, R, VNode, X } from '../../vfs/vfs';
import { modeString } from '../../vfs/perms';
import { abs, Command, Ctx, fsMsg, parseOpts } from './types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

export function lsDate(mtime: number, now: number): string {
  const d = new Date(mtime * 1000);
  const head = `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')}`;
  const recent = mtime <= now && now - mtime < 15778476; // six months
  return recent ? `${head} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : `${head}  ${d.getUTCFullYear()}`;
}

export function humanSize(n: number): string {
  if (n < 1024) return String(n);
  const units = ['K', 'M', 'G', 'T'];
  let v = n, u = -1;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) + units[u] : Math.ceil(v) + units[u];
}

interface Entry { name: string; node: VNode }

function columns(names: string[], display: string[], width: number): string {
  if (names.length === 0) return '';
  for (let cols = names.length; cols >= 1; cols--) {
    const rows = Math.ceil(names.length / cols);
    const widths: number[] = [];
    for (let c = 0; c * rows < names.length; c++) {
      widths.push(Math.max(...names.slice(c * rows, (c + 1) * rows).map((n) => n.length)) + 2);
    }
    if (widths.reduce((a, b) => a + b, 0) - 2 > width && cols > 1) continue;
    let out = '';
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < widths.length; c++) {
        const i = c * rows + r;
        if (i >= names.length) continue;
        const lastInRow = (c + 1) * rows + r >= names.length;
        line += display[i] + (lastInRow ? '' : ' '.repeat(widths[c] - names[i].length));
      }
      out += line + '\n';
    }
    return out;
  }
  return '';
}

function run(ctx: Ctx): number {
  const o = parseOpts(ctx, {
    flags: 'laAhRtr1dS',
    long: { '--all': 'a', '--almost-all': 'A', '--human-readable': 'h', '--recursive': 'R', '--reverse': 'r', '--directory': 'd', '--color': '' },
  });
  if (!o) return 2;
  const { vfs } = ctx.state;
  const f = o.f;
  let code = 0;
  const sorter = (a: Entry, b: Entry): number => {
    let c = 0;
    if (f.t) c = b.node.mtime - a.node.mtime;
    else if (f.S) c = nodeSize(b.node) - nodeSize(a.node);
    if (c === 0) c = cmpC(a.name, b.name);
    return f.r ? -c : c;
  };
  const paint = (e: Entry): string => {
    const quoted = /[ '"]/.test(e.name) && ctx.tty ? `'${e.name}'` : e.name;
    if (!ctx.tty) return e.name;
    if (e.node.type === 'dir') return `\x1b[1;34m${quoted}\x1b[0m`;
    if (e.node.mode & 0o111) return `\x1b[1;32m${quoted}\x1b[0m`;
    return quoted;
  };
  const emit = (entries: Entry[], withTotal: boolean): void => {
    if (f.l) {
      const rows = entries.map((e) => ({
        mode: modeString(e.node.mode, e.node.type === 'dir'),
        nlink: String(e.node.type === 'dir' ? 2 + [...e.node.children.values()].filter((c) => c.type === 'dir').length : 1),
        owner: e.node.owner, group: e.node.group,
        size: f.h ? humanSize(nodeSize(e.node)) : String(nodeSize(e.node)),
        date: lsDate(e.node.mtime, vfs.now), name: paint(e),
      }));
      const w = (k: 'nlink' | 'owner' | 'group' | 'size'): number => Math.max(0, ...rows.map((r) => r[k].length));
      if (withTotal) {
        const blocks = entries.reduce((s, e) => s + (e.node.type === 'dir' ? 4 : Math.ceil(nodeSize(e.node) / 4096) * 4), 0);
        ctx.out(`total ${f.h ? humanSize(blocks * 1024) : blocks}\n`);
      }
      for (const r of rows) {
        ctx.out(`${r.mode} ${r.nlink.padStart(w('nlink'))} ${r.owner.padEnd(w('owner'))} ${r.group.padEnd(w('group'))} ${r.size.padStart(w('size'))} ${r.date} ${r.name}\n`);
      }
    } else if (ctx.tty && !f['1']) {
      ctx.out(columns(entries.map((e) => (/[ '"]/.test(e.name) ? `'${e.name}'` : e.name)), entries.map(paint), ctx.cols));
    } else {
      for (const e of entries) ctx.out(e.name + '\n');
    }
  };

  const files: Entry[] = [], dirs: { name: string; path: string; node: VNode }[] = [];
  for (const t of o.rest.length ? o.rest : ['.']) {
    try {
      const node = vfs.get(abs(ctx, t), ctx.cred);
      if (node.type === 'dir' && !f.d) dirs.push({ name: t, path: abs(ctx, t), node });
      else files.push({ name: t, node });
    } catch (e) {
      ctx.err(`ls: cannot access '${t}': ${fsMsg(e)}\n`);
      code = 2;
    }
  }
  files.sort(sorter);
  dirs.sort((a, b) => sorter(a, b));
  if (files.length) emit(files, false);
  let first = files.length === 0;
  const showHeader = (o.rest.length > 1) || !!f.R;

  const listDir = (name: string, path: string, node: VNode, top: boolean): void => {
    if (node.type !== 'dir') return;
    if (!can(node, ctx.cred, R)) {
      ctx.err(`ls: cannot open directory '${name}': Permission denied\n`);
      code = Math.max(code, top ? 2 : 1);
      return;
    }
    if (!first) ctx.out('\n');
    first = false;
    if (showHeader) ctx.out(`${name}:\n`);
    let entries: Entry[] = [...node.children].map(([n, c]) => ({ name: n, node: c }));
    if (!f.a && !f.A) entries = entries.filter((e) => !e.name.startsWith('.'));
    if (f.a) {
      entries.push({ name: '.', node });
      const parent = vfs.tryGet(path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/');
      entries.push({ name: '..', node: parent ?? node });
    }
    entries.sort(sorter);
    if (f.l && !can(node, ctx.cred, X)) {
      for (const e of entries) ctx.err(`ls: cannot access '${name}/${e.name}': Permission denied\n`);
      code = Math.max(code, 1);
      return;
    }
    emit(entries, true);
    if (f.R) {
      for (const e of entries) {
        if (e.node.type === 'dir' && e.name !== '.' && e.name !== '..') {
          listDir(name.endsWith('/') ? name + e.name : `${name}/${e.name}`, `${path === '/' ? '' : path}/${e.name}`, e.node, false);
        }
      }
    }
  };
  for (const d of dirs) listDir(d.name, d.path, d.node, true);
  return code;
}

export const ls: Command = {
  run,
  help: {
    summary: 'list directory contents',
    usage: 'ls [OPTION]... [FILE]...',
    options: [
      ['-l', 'long format: permissions, owner, group, size, mtime'],
      ['-a', 'include entries starting with . (hidden files)'],
      ['-A', 'like -a but without . and ..'],
      ['-h', 'with -l, human-readable sizes'],
      ['-R', 'recurse into subdirectories'],
      ['-t', 'sort by modification time, newest first'],
      ['-S', 'sort by size, largest first'],
      ['-r', 'reverse the sort order'],
      ['-d', 'list directories themselves, not their contents'],
      ['-1', 'one entry per line'],
    ],
    examples: [['ls -la ~/.ssh', 'check permissions on SSH keys, including hidden files'], ['ls -lt /etc/cron.d', 'spot recently changed cron files']],
  },
};
