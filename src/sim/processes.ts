// Simulated process table plus a generated /proc view. No real processes are involved.
import { VFS } from '../vfs/vfs';

export interface Listen { proto: 'tcp' | 'udp'; addr: string; port: number }
export interface Proc {
  pid: number; ppid: number; user: string; cmd: string;
  tty: string; stat: string; start: string; time: number; // CPU seconds
  cpu: number; mem: number; vsz: number; rss: number;
  listen: Listen[];
}
export type ProcSpec = Pick<Proc, 'pid' | 'user' | 'cmd'> & Partial<Proc>;

export const SIGNALS: Record<string, number> = {
  HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6, BUS: 7, FPE: 8, KILL: 9, USR1: 10,
  SEGV: 11, USR2: 12, PIPE: 13, ALRM: 14, TERM: 15, STKFLT: 16, CHLD: 17, CONT: 18, STOP: 19, TSTP: 20,
};
const NON_FATAL = new Set([0, 17, 18, 19, 20]);

export const commName = (cmd: string): string => {
  const first = cmd.split(' ')[0].replace(/:$/, '').replace(/^-/, '');
  return first.startsWith('[') ? first.replace(/[[\]]/g, '') : first.slice(first.lastIndexOf('/') + 1);
};

export class ProcessTable {
  procs: Proc[] = [];
  nextPid = 4200;
  constructor(specs: ProcSpec[] = []) { specs.forEach((s) => this.add(s)); }

  add(s: ProcSpec): Proc {
    const p: Proc = {
      ppid: 1, tty: '?', stat: 'Ss', start: '08:00', time: 0, cpu: 0, mem: 0.1,
      vsz: 8000 + ((s.pid * 37) % 9000), rss: 1200 + ((s.pid * 13) % 3000), listen: [], ...s,
    };
    this.procs.push(p);
    this.procs.sort((a, b) => a.pid - b.pid);
    return p;
  }
  get(pid: number): Proc | undefined { return this.procs.find((p) => p.pid === pid); }
  isRunning(match: string | RegExp): boolean {
    return this.procs.some((p) => (typeof match === 'string' ? p.cmd.includes(match) : match.test(p.cmd)));
  }
  /** Deliver a signal. Returns false if the signal does not terminate the process. */
  signal(pid: number, sig: number): boolean {
    if (NON_FATAL.has(sig)) return false;
    if (pid === 1) return false; // the kernel protects init
    this.procs = this.procs.filter((p) => p.pid !== pid);
    return true;
  }
  allocPid(): number { return this.nextPid++; }
}

/** Regenerate /proc/<pid>/{cmdline,comm,status} from the process table. */
export function syncProcfs(vfs: VFS, table: ProcessTable): void {
  const proc = vfs.putDir('/proc', { mode: 0o555 });
  proc.children.clear();
  for (const p of table.procs) {
    const base = `/proc/${p.pid}`;
    vfs.putDir(base, { mode: 0o555, owner: p.user, group: p.user });
    const o = { mode: 0o444, owner: p.user, group: p.user };
    // Real cmdline is NUL-separated; we use spaces + newline so it reads cleanly with cat.
    vfs.putFile(`${base}/cmdline`, p.cmd + '\n', o);
    vfs.putFile(`${base}/comm`, commName(p.cmd) + '\n', o);
    vfs.putFile(`${base}/status`,
      `Name:\t${commName(p.cmd)}\nState:\t${p.stat[0]} (${p.stat[0] === 'R' ? 'running' : 'sleeping'})\n` +
      `Pid:\t${p.pid}\nPPid:\t${p.ppid}\nUser:\t${p.user}\nVmSize:\t${p.vsz} kB\nVmRSS:\t${p.rss} kB\n`, o);
  }
}
