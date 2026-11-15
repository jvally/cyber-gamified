// Helpers for declaring level filesystems, plus the base "machine" every level starts from.
import { VFS } from '../vfs/vfs';
import { ProcessTable, ProcSpec, syncProcfs } from '../sim/processes';
import { defaultUsers } from '../sim/users';
import type { GameState } from '../shell/state';
import type { FileSpec } from './types';

export const at = (iso: string): number => Date.parse(iso) / 1000;
export const DAY = 86400;

type Opts = Omit<FileSpec, 'path' | 'content' | 'dir'>;
export const file = (path: string, content: string, o: Opts = {}): FileSpec => ({ path, content, ...o });
export const dir = (path: string, o: Opts = {}): FileSpec => ({ path, dir: true, ...o });
/** Trim a template literal: drop the leading newline and common indentation. */
export function text(s: string): string {
  const lines = s.replace(/^\n/, '').replace(/\n[ \t]*$/, '\n').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
}

/** Small deterministic PRNG so generated logs are identical on every run. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function baseFiles(now: number, hostname = 'web01'): FileSpec[] {
  const old = now - 120 * DAY;
  const users = defaultUsers();
  const a = { owner: 'analyst', group: 'analyst', mtime: old };
  return [
    dir('/', { mtime: old }),
    dir('/bin', { mtime: old }), dir('/usr/bin', { mtime: old }), dir('/usr/local/bin', { mtime: old }),
    dir('/var/log', { mtime: old }), dir('/var/www', { mtime: old }), dir('/opt', { mtime: old }),
    dir('/tmp', { mode: 0o1777, mtime: now - 3600 }), dir('/var/tmp', { mode: 0o1777, mtime: old }),
    dir('/root', { mode: 0o700, mtime: old }),
    dir('/dev', { mtime: old }), file('/dev/null', '', { mode: 0o666, mtime: old }),
    file('/etc/passwd', users.passwd(), { mtime: old }),
    file('/etc/group', users.groupFile(), { mtime: old }),
    file('/etc/shadow', users.users.map((u) => `${u.name}:${u.shell.endsWith('bash') ? '$y$j9T$<redacted>' : '*'}:19800:0:99999:7:::`).join('\n') + '\n', { mode: 0o640, mtime: old }),
    file('/etc/hostname', hostname + '\n', { mtime: old }),
    file('/etc/os-release', 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n', { mtime: old }),
    dir('/home', { mtime: old }),
    dir('/home/analyst', { mode: 0o750, ...a }),
    file('/home/analyst/.bashrc', '# ~/.bashrc\nexport HISTSIZE=1000\nalias ll="ls -alF"\n', a),
    file('/home/analyst/.profile', '# ~/.profile: executed by the login shell\n', a),
  ];
}

export function baseProcs(): ProcSpec[] {
  return [
    { pid: 1, ppid: 0, user: 'root', cmd: '/sbin/init', time: 3, vsz: 167744, rss: 11520 },
    { pid: 2, ppid: 0, user: 'root', cmd: '[kthreadd]', stat: 'S', vsz: 0, rss: 0 },
    { pid: 412, user: 'root', cmd: '/lib/systemd/systemd-journald', time: 1 },
    { pid: 588, user: 'syslog', cmd: '/usr/sbin/rsyslogd -n -iNONE', stat: 'Ssl' },
    { pid: 601, user: 'root', cmd: '/usr/sbin/cron -f -P' },
    { pid: 612, user: 'root', cmd: 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups', listen: [{ proto: 'tcp', addr: '0.0.0.0', port: 22 }] },
    { pid: 2001, ppid: 612, user: 'analyst', cmd: 'sshd: analyst@pts/0', stat: 'S', start: '08:55' },
    { pid: 2002, ppid: 2001, user: 'analyst', cmd: '-bash', tty: 'pts/0', start: '08:55' },
  ];
}

export interface MachineSpec {
  now: number; files: FileSpec[]; procs: ProcSpec[];
  user?: string; cwd?: string; hostname?: string;
}

export function buildState(spec: MachineSpec): GameState {
  const users = defaultUsers();
  const vfs = new VFS(spec.now);
  for (const f of spec.files) {
    const o = { mode: f.mode, owner: f.owner, group: f.group, mtime: f.mtime };
    if (f.dir) vfs.putDir(f.path, o);
    else vfs.putFile(f.path, f.content ?? '', o);
  }
  const procs = new ProcessTable(spec.procs);
  syncProcfs(vfs, procs);
  const user = spec.user ?? 'analyst';
  const home = users.get(user)?.home ?? '/';
  const cwd = spec.cwd ?? home;
  const hostname = spec.hostname ?? 'web01';
  return {
    vfs, procs, users, cwd, user, hostname, tty: 'pts/0', shellPid: 2002,
    env: { HOME: home, USER: user, LOGNAME: user, PWD: cwd, SHELL: '/bin/bash', HOSTNAME: hostname, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    submitted: [], history: [], lastExit: 0,
  };
}
