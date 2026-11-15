import { FsError, VNode } from '../../vfs/vfs';
import { applyMode } from '../../vfs/perms';
import { abs, Command, Ctx, fsMsg } from './types';

function eachTarget(ctx: Ctx, target: string, recursive: boolean, fn: (path: string, node: VNode, shown: string) => void): void {
  const walk = (path: string, shown: string): void => {
    const node = ctx.state.vfs.get(path, ctx.cred);
    fn(path, node, shown);
    if (recursive && node.type === 'dir') {
      for (const name of [...node.children.keys()].sort()) walk(`${path === '/' ? '' : path}/${name}`, `${shown.replace(/\/$/, '')}/${name}`);
    }
  };
  walk(abs(ctx, target), target);
}

const chmod: Command = {
  run(ctx) {
    let recursive = false, mode: string | undefined;
    const files: string[] = [];
    let endOpts = false;
    for (const a of ctx.args) {
      if (!endOpts && a === '--') { endOpts = true; continue; }
      if (!endOpts && (/^-[Rvcf]+$/.test(a) || a === '--recursive')) { if (a.includes('R') || a === '--recursive') recursive = true; continue; }
      if (mode === undefined) { mode = a; continue; }
      files.push(a);
    }
    if (mode === undefined) { ctx.err("chmod: missing operand\nTry 'chmod --help' for more information.\n"); return 1; }
    if (files.length === 0) { ctx.err(`chmod: missing operand after '${mode}'\nTry 'chmod --help' for more information.\n`); return 1; }
    if (applyMode(mode, 0, false) === null) { ctx.err(`chmod: invalid mode: '${mode}'\nTry 'chmod --help' for more information.\n`); return 1; }
    let code = 0;
    for (const f of files) {
      try {
        eachTarget(ctx, f, recursive, (path, node, shown) => {
          try {
            ctx.state.vfs.chmod(path, applyMode(mode!, node.mode, node.type === 'dir')!, ctx.cred);
          } catch (e) {
            ctx.err(`chmod: changing permissions of '${shown}': ${fsMsg(e)}\n`);
            code = 1;
          }
        });
      } catch (e) {
        ctx.err(`chmod: cannot access '${f}': ${fsMsg(e)}\n`);
        code = 1;
      }
    }
    return code;
  },
  help: {
    summary: 'change file mode bits',
    usage: 'chmod [-R] MODE FILE...',
    options: [
      ['-R', 'change files and directories recursively'],
      ['MODE (octal)', '600 = rw-------, 644 = rw-r--r--, 755 = rwxr-xr-x (r=4 w=2 x=1 per user/group/other)'],
      ['MODE (symbolic)', '[ugoa][+-=][rwxXst], comma-separated: go-rwx, u=rw,go=, a+x'],
    ],
    notes: 'Only the owner or root may change a file\'s mode.',
    examples: [['chmod 600 ~/.ssh/id_ed25519', 'private key readable by owner only'], ['chmod go-rwx secret.txt', 'strip all group/other access']],
  },
};

const chown: Command = {
  run(ctx) {
    let recursive = false, spec: string | undefined;
    const files: string[] = [];
    for (const a of ctx.args) {
      if (/^-[Rvcf]+$/.test(a) || a === '--recursive') { if (a.includes('R') || a === '--recursive') recursive = true; continue; }
      if (spec === undefined) { spec = a; continue; }
      files.push(a);
    }
    if (spec === undefined) { ctx.err("chown: missing operand\nTry 'chown --help' for more information.\n"); return 1; }
    if (files.length === 0) { ctx.err(`chown: missing operand after '${spec}'\nTry 'chown --help' for more information.\n`); return 1; }
    const { users } = ctx.state;
    const [u, g] = spec.includes(':') ? [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)] : [spec, undefined];
    const owner = u === '' ? undefined : u;
    if (owner !== undefined && !users.get(owner)) { ctx.err(`chown: invalid user: '${spec}'\n`); return 1; }
    const group = g === undefined ? undefined : g === '' ? owner : g;
    if (group !== undefined && !users.hasGroup(group)) { ctx.err(`chown: invalid group: '${spec}'\n`); return 1; }
    let code = 0;
    for (const f of files) {
      try {
        eachTarget(ctx, f, recursive, (path, _n, shown) => {
          try { ctx.state.vfs.chown(path, owner, group, ctx.cred); } catch (e) {
            ctx.err(`chown: changing ownership of '${shown}': ${fsMsg(e)}\n`);
            code = 1;
          }
        });
      } catch (e) {
        ctx.err(`chown: cannot access '${f}': ${e instanceof FsError ? e.message : e}\n`);
        code = 1;
      }
    }
    return code;
  },
  help: {
    summary: 'change file owner and group',
    usage: 'chown [-R] OWNER[:GROUP] FILE...',
    options: [['-R', 'operate recursively'], ['OWNER:GROUP', 'set both; OWNER alone keeps the group; :GROUP changes only the group']],
    notes: 'Changing the owner requires root (use sudo).',
    examples: [['sudo chown root:root /etc/cron.d/backup', 'cron files must be owned by root']],
  },
};

export const perms = { chmod, chown };
