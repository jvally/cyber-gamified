import { basename, can, dirname, FsError, normalize, VNode, X } from '../../vfs/vfs';
import { abs, Command, Ctx, fsMsg, parseOpts, readInputs, splitLines } from './types';

const cd: Command = {
  run(ctx) {
    const { state } = ctx;
    if (ctx.args.length > 1) { ctx.err('bash: cd: too many arguments\n'); return 1; }
    let target = ctx.args[0] ?? state.env.HOME;
    const dash = target === '-';
    if (dash) {
      if (!state.env.OLDPWD) { ctx.err('bash: cd: OLDPWD not set\n'); return 1; }
      target = state.env.OLDPWD;
    }
    const path = abs(ctx, target);
    try {
      const node = state.vfs.get(path, ctx.cred);
      if (node.type !== 'dir') throw new FsError('ENOTDIR', path);
      if (!can(node, ctx.cred, X)) throw new FsError('EACCES', path);
    } catch (e) {
      ctx.err(`bash: cd: ${target}: ${fsMsg(e)}\n`);
      return 1;
    }
    state.env.OLDPWD = state.cwd;
    state.cwd = state.env.PWD = path;
    if (dash) ctx.out(path + '\n');
    return 0;
  },
  help: {
    summary: 'change the working directory',
    usage: 'cd [DIR]',
    notes: '`cd` alone goes to $HOME, `cd -` returns to the previous directory, `cd ..` goes up one level.',
    examples: [['cd /var/log', 'go where the logs live']],
  },
};

const pwd: Command = {
  run(ctx) { ctx.out(ctx.state.cwd + '\n'); return 0; },
  help: { summary: 'print the working directory', usage: 'pwd' },
};

const cat: Command = {
  run(ctx) {
    const o = parseOpts(ctx, { flags: 'nb', long: { '--number': 'n' } });
    if (!o) return 1;
    const inputs = readInputs(ctx, o.rest);
    let n = 0;
    for (const { content } of inputs) {
      if (!o.f.n && !o.f.b) { ctx.out(content); continue; }
      const lines = splitLines(content);
      const trailing = content.endsWith('\n') || content === '';
      lines.forEach((l, i) => {
        const numbered = !(o.f.b && l === '');
        ctx.out((numbered ? `${String(++n).padStart(6)}\t` : '') + l + (i < lines.length - 1 || trailing ? '\n' : ''));
      });
    }
    return inputs.failed ? 1 : 0;
  },
  help: {
    summary: 'print files to standard output',
    usage: 'cat [-n] [FILE]...',
    options: [['-n', 'number all output lines'], ['-b', 'number non-empty lines']],
    examples: [['cat /etc/passwd', 'read the account database']],
  },
};

function headTail(which: 'head' | 'tail'): Command {
  return {
    run(ctx) {
      const args = ctx.args.map((a, k) => (/^-\d+$/.test(a) && !/^-[nc]$|^--(lines|bytes)$/.test(ctx.args[k - 1] ?? '') ? `-n${a.slice(1)}` : a));
      if (which === 'tail' && args.some((a) => /^-[a-z]*[fF]/.test(a) || a === '--follow')) {
        ctx.err('tail: -f (follow) is not supported in this simulator\n');
        return 1;
      }
      const o = parseOpts(ctx, { flags: 'qv', values: 'nc', long: { '--lines': 'n', '--bytes': 'c', '--quiet': 'q', '--verbose': 'v' } }, args);
      if (!o) return 1;
      const byBytes = o.v.c !== undefined;
      const raw = byBytes ? o.v.c : o.v.n ?? '10';
      const m = /^([+-]?)(\d+)$/.exec(raw);
      if (!m) {
        ctx.err(`${which}: invalid number of ${byBytes ? 'bytes' : 'lines'}: '${raw}'\n`);
        return 1;
      }
      const sign = m[1], n = parseInt(m[2], 10);
      const files = o.rest.length ? o.rest : ['-'];
      const headers = !o.f.q && (files.length > 1 || o.f.v);
      let code = 0, first = true;
      for (const file of files) {
        const [input] = readInputs(ctx, [file], (fl, msg) => `${which}: cannot open '${fl}' for reading: ${msg}`);
        if (!input) { code = 1; continue; }
        if (headers) {
          ctx.out(`${first ? '' : '\n'}==> ${file === '-' ? 'standard input' : file} <==\n`);
        }
        first = false;
        const c = input.content;
        if (byBytes) {
          if (which === 'head') ctx.out(sign === '-' ? c.slice(0, Math.max(0, c.length - n)) : c.slice(0, n));
          else ctx.out(sign === '+' ? c.slice(Math.max(0, n - 1)) : n === 0 ? '' : c.slice(-n));
          continue;
        }
        const lines = splitLines(c);
        let from = 0, to = lines.length;
        if (which === 'head') to = sign === '-' ? Math.max(0, lines.length - n) : Math.min(n, lines.length);
        else from = sign === '+' ? Math.max(0, n - 1) : Math.max(0, lines.length - n);
        for (let k = from; k < to; k++) ctx.out(lines[k] + (k === lines.length - 1 && !c.endsWith('\n') ? '' : '\n'));
      }
      return code;
    },
    help: which === 'head' ? {
      summary: 'output the first part of files',
      usage: 'head [-n N] [-c N] [FILE]...',
      options: [['-n N', 'first N lines (default 10); -n -N prints all but the last N'], ['-N', 'shorthand for -n N'], ['-c N', 'first N bytes'], ['-q', 'never print file-name headers']],
      examples: [['sort -rn counts.txt | head -n 3', 'top three entries']],
    } : {
      summary: 'output the last part of files',
      usage: 'tail [-n N] [-c N] [FILE]...',
      options: [['-n N', 'last N lines (default 10); -n +N starts at line N'], ['-N', 'shorthand for -n N'], ['-c N', 'last N bytes'], ['-q', 'never print file-name headers']],
      examples: [['tail -n 20 /var/log/auth.log', 'most recent authentication events']],
      notes: '-f (follow) is not supported.',
    },
  };
}

function removeTree(ctx: Ctx, path: string): void {
  const node = ctx.state.vfs.get(path, ctx.cred);
  if (node.type === 'dir') {
    for (const name of ctx.state.vfs.list(path, ctx.cred)) removeTree(ctx, `${path === '/' ? '' : path}/${name}`);
  }
  ctx.state.vfs.remove(path, ctx.cred);
}

const rm: Command = {
  run(ctx) {
    const o = parseOpts(ctx, { flags: 'rRfv', long: { '--recursive': 'r', '--force': 'f', '--verbose': 'v' } });
    if (!o) return 1;
    const recursive = o.f.r || o.f.R;
    if (o.rest.length === 0) {
      if (o.f.f) return 0;
      ctx.err("rm: missing operand\nTry 'rm --help' for more information.\n");
      return 1;
    }
    let code = 0;
    for (const t of o.rest) {
      const path = abs(ctx, t);
      try {
        if (path === '/') {
          ctx.err("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n");
          code = 1;
          continue;
        }
        const node = ctx.state.vfs.get(path, ctx.cred);
        if (node.type === 'dir' && !recursive) throw new FsError('EISDIR', path);
        if ((ctx.state.cwd + '/').startsWith(path + '/')) {
          ctx.err(`rm: refusing to remove '${t}': it contains the current directory\n`);
          code = 1;
          continue;
        }
        removeTree(ctx, path);
        if (o.f.v) ctx.out(`removed '${t}'\n`);
      } catch (e) {
        if (o.f.f && e instanceof FsError && e.code === 'ENOENT') continue;
        ctx.err(`rm: cannot remove '${t}': ${fsMsg(e)}\n`);
        code = 1;
      }
    }
    return code;
  },
  help: {
    summary: 'remove files or directories',
    usage: 'rm [-rf] FILE...',
    options: [['-r, -R', 'remove directories and their contents'], ['-f', 'ignore missing files'], ['-v', 'say what was removed']],
    notes: 'Removing a file needs write permission on its *directory*, not on the file.',
    examples: [['sudo rm /etc/cron.d/suspicious', 'delete a root-owned file']],
  },
};

function copyNode(ctx: Ctx, node: VNode, dst: string, preserve: boolean): void {
  const { vfs } = ctx.state;
  if (node.type === 'file') {
    const existed = vfs.exists(dst);
    vfs.writeFile(dst, node.content, ctx.cred, false, node.mode & 0o777 & ~0o022);
    if (!existed && preserve) { const n = vfs.get(dst); n.mode = node.mode; n.mtime = node.mtime; if (ctx.cred.user === 'root') { n.owner = node.owner; n.group = node.group; } }
    return;
  }
  if (!vfs.exists(dst)) vfs.mkdir(dst, ctx.cred, node.mode & 0o777);
  for (const [name, child] of node.children) copyNode(ctx, child, `${dst}/${name}`, preserve);
}

function cpMv(which: 'cp' | 'mv'): Command {
  return {
    run(ctx) {
      const o = parseOpts(ctx, { flags: which === 'cp' ? 'rRpafv' : 'fv', long: { '--recursive': 'r' } });
      if (!o) return 1;
      const { vfs } = ctx.state;
      if (o.rest.length === 0) { ctx.err(`${which}: missing file operand\nTry '${which} --help' for more information.\n`); return 1; }
      if (o.rest.length === 1) {
        ctx.err(`${which}: missing destination file operand after '${o.rest[0]}'\nTry '${which} --help' for more information.\n`);
        return 1;
      }
      const dest = o.rest[o.rest.length - 1];
      const sources = o.rest.slice(0, -1);
      const destAbs = abs(ctx, dest);
      const destIsDir = vfs.isDir(destAbs);
      if (sources.length > 1 && !destIsDir) { ctx.err(`${which}: target '${dest}' is not a directory\n`); return 1; }
      let code = 0;
      for (const s of sources) {
        const srcAbs = abs(ctx, s);
        let node: VNode;
        try { node = vfs.get(srcAbs, ctx.cred); } catch (e) {
          ctx.err(`${which}: cannot stat '${s}': ${fsMsg(e)}\n`);
          code = 1;
          continue;
        }
        const target = destIsDir ? normalize(basename(srcAbs), destAbs) : destAbs;
        const shown = destIsDir ? `${dest.replace(/\/$/, '')}/${basename(srcAbs)}` : dest;
        if (target === srcAbs) { ctx.err(`${which}: '${s}' and '${shown}' are the same file\n`); code = 1; continue; }
        try {
          if (which === 'cp') {
            if (node.type === 'dir' && !(o.f.r || o.f.R || o.f.a)) {
              ctx.err(`cp: -r not specified; omitting directory '${s}'\n`);
              code = 1;
              continue;
            }
            if (node.type === 'file') vfs.readFile(srcAbs, ctx.cred);
            copyNode(ctx, node, target, !!(o.f.p || o.f.a));
          } else {
            vfs.rename(srcAbs, target, ctx.cred);
          }
          if (o.f.v) ctx.out(which === 'cp' ? `'${s}' -> '${shown}'\n` : `renamed '${s}' -> '${shown}'\n`);
        } catch (e) {
          const code_ = (e as FsError).code;
          if (which === 'cp' && code_ === 'EACCES' && (e as FsError).path === srcAbs) ctx.err(`cp: cannot open '${s}' for reading: Permission denied\n`);
          else if (which === 'cp') ctx.err(`cp: cannot create regular file '${shown}': ${fsMsg(e)}\n`);
          else ctx.err(`mv: cannot move '${s}' to '${shown}': ${fsMsg(e)}\n`);
          code = 1;
        }
      }
      return code;
    },
    help: which === 'cp' ? {
      summary: 'copy files and directories',
      usage: 'cp [-rp] SOURCE... DEST',
      options: [['-r, -R', 'copy directories recursively'], ['-p', 'preserve mode and timestamps'], ['-v', 'explain what is being done']],
      examples: [['cp /etc/crontab /tmp/crontab.bak', 'keep evidence before changing a file']],
    } : {
      summary: 'move (rename) files',
      usage: 'mv SOURCE... DEST',
      options: [['-v', 'explain what is being done']],
      examples: [['sudo mv /etc/cron.d/evil /root/quarantine/', 'quarantine instead of deleting']],
    },
  };
}

const mkdir: Command = {
  run(ctx) {
    const o = parseOpts(ctx, { flags: 'pv', long: { '--parents': 'p' } });
    if (!o) return 1;
    if (o.rest.length === 0) { ctx.err("mkdir: missing operand\nTry 'mkdir --help' for more information.\n"); return 1; }
    let code = 0;
    for (const t of o.rest) {
      const path = abs(ctx, t);
      try {
        if (o.f.p) {
          let cur = '';
          for (const seg of path.split('/').filter(Boolean)) {
            cur += '/' + seg;
            const n = ctx.state.vfs.tryGet(cur);
            if (!n) ctx.state.vfs.mkdir(cur, ctx.cred);
            else if (n.type !== 'dir') throw new FsError('EEXIST', cur);
          }
        } else ctx.state.vfs.mkdir(path, ctx.cred);
      } catch (e) {
        ctx.err(`mkdir: cannot create directory '${t}': ${fsMsg(e)}\n`);
        code = 1;
      }
    }
    return code;
  },
  help: { summary: 'create directories', usage: 'mkdir [-p] DIR...', options: [['-p', 'create parents as needed; no error if it exists']] },
};

const touch: Command = {
  run(ctx) {
    const o = parseOpts(ctx, { flags: 'c' });
    if (!o) return 1;
    if (o.rest.length === 0) { ctx.err("touch: missing file operand\nTry 'touch --help' for more information.\n"); return 1; }
    let code = 0;
    for (const t of o.rest) {
      const path = abs(ctx, t);
      try {
        const n = ctx.state.vfs.tryGet(path, ctx.cred);
        if (n) {
          if (ctx.cred.user !== 'root' && n.owner !== ctx.cred.user) throw new FsError('EACCES', path);
          n.mtime = ctx.state.vfs.now;
        } else if (!o.f.c) {
          ctx.state.vfs.get(dirname(path), ctx.cred);
          ctx.state.vfs.writeFile(path, '', ctx.cred);
        }
      } catch (e) {
        ctx.err(`touch: cannot touch '${t}': ${fsMsg(e)}\n`);
        code = 1;
      }
    }
    return code;
  },
  help: { summary: 'create an empty file or update its modification time', usage: 'touch FILE...' },
};

export const fileops = { cd, pwd, cat, head: headTail('head'), tail: headTail('tail'), rm, cp: cpMv('cp'), mv: cpMv('mv'), mkdir, touch };
