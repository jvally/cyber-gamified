import { commName, Proc, SIGNALS } from '../../sim/processes';
import { Command, parseOpts } from './types';

const hms = (s: number): string => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
const ms = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const ps: Command = {
  run(ctx) {
    const { state } = ctx;
    let all = false, fmt: 'short' | 'u' | 'f' = 'short', userSel: string | undefined, pidSel: number[] | undefined;
    const args = [...ctx.args];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-u' || a === '-U' || a === '--user') { userSel = args[++i]; continue; }
      if (a === '-p' || a === '--pid') { pidSel = (args[++i] ?? '').split(',').map(Number); continue; }
      if (a.startsWith('-')) {
        for (const c of a.slice(1)) {
          if (c === 'e' || c === 'A') all = true;
          else if (c === 'f') fmt = 'f';
          else { ctx.err(`error: unsupported SysV option\n\nUsage:\n ps [options]\n\n Supported here: ps, ps aux, ps -ef, ps -e, ps -u USER, ps -p PID\n`); return 1; }
        }
        continue;
      }
      for (const c of a) {
        if (c === 'a' || c === 'x') all = all || (a.includes('a') && a.includes('x'));
        else if (c === 'u') fmt = 'u';
        else { ctx.err(`error: unsupported option (BSD syntax)\n\nUsage:\n ps [options]\n\n Supported here: ps, ps aux, ps -ef, ps -e, ps -u USER, ps -p PID\n`); return 1; }
      }
    }
    if (userSel !== undefined && !state.users.get(userSel)) { ctx.err(`error: user name does not exist\n`); return 1; }
    // The commands of the running pipeline are themselves processes, as on a real system.
    const hh = new Date(state.vfs.now * 1000).toISOString().slice(11, 16);
    const transient: Proc[] = ctx.pipeline.map((cmd) => ({
      pid: state.procs.allocPid(), ppid: state.shellPid, user: ctx.cred.user, cmd: cmd.replace(/^sudo /, ''),
      tty: state.tty, stat: 'R+', start: hh, time: 0, cpu: 0, mem: 0, vsz: 9000, rss: 2200, listen: [],
    }));
    let procs = [...state.procs.procs, ...transient];
    if (pidSel) procs = procs.filter((p) => pidSel!.includes(p.pid));
    else if (userSel !== undefined) procs = procs.filter((p) => p.user === userSel);
    else if (!all) procs = procs.filter((p) => p.tty === state.tty);
    if (fmt === 'u') {
      ctx.out('USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n');
      for (const p of procs) {
        ctx.out(`${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ${String(p.vsz).padStart(6)} ${String(p.rss).padStart(5)} ${p.tty.padEnd(8)} ${p.stat.padEnd(4)} ${p.start.padStart(5)} ${ms(p.time).padStart(6)} ${p.cmd}\n`);
      }
    } else if (fmt === 'f') {
      ctx.out('UID          PID    PPID  C STIME TTY          TIME CMD\n');
      for (const p of procs) {
        ctx.out(`${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${String(p.ppid).padStart(7)} ${String(Math.round(p.cpu)).padStart(2)} ${p.start.padStart(5)} ${p.tty.padEnd(8)} ${hms(p.time)} ${p.cmd}\n`);
      }
    } else {
      ctx.out('    PID TTY          TIME CMD\n');
      for (const p of procs) ctx.out(`${String(p.pid).padStart(7)} ${p.tty.padEnd(8)} ${hms(p.time)} ${commName(p.cmd)}\n`);
    }
    return pidSel && procs.length === 0 ? 1 : 0;
  },
  help: {
    summary: 'report a snapshot of current processes',
    usage: 'ps [aux | -ef | -e | -u USER | -p PID]',
    options: [
      ['(none)', 'processes attached to your terminal'], ['aux', 'every process, with owner, CPU, memory and full command line'],
      ['-ef', 'every process, with parent PID (PPID)'], ['-e, -A', 'every process, short format'],
      ['-u USER', 'processes owned by USER'], ['-p PID[,PID]', 'only these PIDs'],
    ],
    notes: 'Custom output formats (-o) and process trees are not supported.',
    examples: [['ps aux | grep -v root', 'what is running that is not root?'], ['ps -ef | grep 3127', 'find a process and its parent']],
  },
};

const kill: Command = {
  run(ctx) {
    const { procs } = ctx.state;
    const args = [...ctx.args];
    const usage = (): number => {
      ctx.err('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n');
      return 2;
    };
    if (args.length === 0) return usage();
    if (args[0] === '-l' || args[0] === '-L') {
      const names = Object.entries(SIGNALS).map(([n, v]) => `${String(v).padStart(2)}) SIG${n}`);
      for (let i = 0; i < names.length; i += 5) ctx.out(names.slice(i, i + 5).join('\t') + '\n');
      return 0;
    }
    let sig = 15;
    const parseSig = (s: string): number | null => {
      if (/^\d+$/.test(s)) return parseInt(s, 10);
      const v = SIGNALS[s.toUpperCase().replace(/^SIG/, '')];
      return v ?? null;
    };
    if (args[0] === '-s' || args[0] === '-n') {
      if (args.length < 2) return usage();
      const v = parseSig(args[1]);
      if (v === null) { ctx.err(`bash: kill: ${args[1]}: invalid signal specification\n`); return 1; }
      sig = v;
      args.splice(0, 2);
    } else if (args[0].startsWith('-') && args[0] !== '--') {
      const v = parseSig(args[0].slice(1));
      if (v === null) { ctx.err(`bash: kill: ${args[0].slice(1)}: invalid signal specification\n`); return 1; }
      sig = v;
      args.shift();
    }
    if (args[0] === '--') args.shift();
    if (args.length === 0) return usage();
    let code = 0;
    for (const a of args) {
      if (!/^\d+$/.test(a)) { ctx.err(`bash: kill: ${a}: arguments must be process or job IDs\n`); code = 1; continue; }
      const pid = parseInt(a, 10);
      const p = procs.get(pid);
      if (!p) { ctx.err(`bash: kill: (${pid}) - No such process\n`); code = 1; continue; }
      if (ctx.cred.user !== 'root' && p.user !== ctx.cred.user) {
        ctx.err(`bash: kill: (${pid}) - Operation not permitted\n`);
        code = 1;
        continue;
      }
      if (pid === ctx.state.shellPid) {
        if (sig === 9) ctx.err('(simulator) that would end your own shell session; ignoring.\n');
        continue;
      }
      procs.signal(pid, sig);
    }
    return code;
  },
  help: {
    summary: 'send a signal to a process',
    usage: 'kill [-SIGNAL] PID...',
    options: [
      ['(default)', 'SIGTERM (15): ask the process to exit cleanly'], ['-9, -KILL, -SIGKILL', 'force-kill; cannot be caught or ignored'],
      ['-s NAME', 'send the named signal'], ['-0', 'send nothing; just test whether the PID exists'], ['-l', 'list signal names'],
    ],
    notes: 'You can only signal your own processes unless you are root (sudo). Prefer SIGTERM first; SIGKILL gives the process no chance to clean up.',
    examples: [['sudo kill 3127', 'terminate another user\'s process']],
  },
};

const SERVICES: Record<number, string> = { 22: 'ssh', 25: 'smtp', 53: 'domain', 80: 'http', 443: 'https', 3306: 'mysql', 5432: 'postgresql', 6379: 'redis' };

const ss: Command = {
  run(ctx) {
    const o = parseOpts(ctx, {
      flags: 'tulnpa46H',
      long: { '--tcp': 't', '--udp': 'u', '--listening': 'l', '--numeric': 'n', '--processes': 'p', '--all': 'a' },
    });
    if (!o) return 255;
    const f = o.f;
    const both = !!f.t === !!f.u;
    const rows: string[][] = [];
    if (f.l || f.a) {
      for (const p of ctx.state.procs.procs) {
        for (const l of p.listen) {
          if (!both && ((f.t && l.proto !== 'tcp') || (f.u && l.proto !== 'udp'))) continue;
          const port = f.n ? String(l.port) : SERVICES[l.port] ?? String(l.port);
          const visible = ctx.cred.user === 'root' || ctx.cred.user === p.user;
          rows.push([
            ...(both ? [l.proto] : []), l.proto === 'tcp' ? 'LISTEN' : 'UNCONN', '0', l.proto === 'tcp' ? '128' : '0',
            `${l.addr}:${port}`, `${l.addr.includes(':') ? '[::]' : '0.0.0.0'}:*`,
            ...(f.p ? [visible ? `users:(("${commName(p.cmd)}",pid=${p.pid},fd=3))` : ''] : []),
          ]);
        }
      }
      rows.sort((a, b) => {
        const pa = parseInt(a[both ? 4 : 3].split(':').pop()!, 10), pb = parseInt(b[both ? 4 : 3].split(':').pop()!, 10);
        return (pa || 0) - (pb || 0);
      });
    }
    const header = [...(both ? ['Netid'] : []), 'State', 'Recv-Q', 'Send-Q', 'Local Address:Port', 'Peer Address:Port', ...(f.p ? ['Process'] : [])];
    const table = f.H ? rows : [header, ...rows];
    const rightAligned = new Set([both ? 4 : 3, both ? 5 : 4]);
    const widths = header.map((_, c) => Math.max(...table.map((r) => r[c].length), 0));
    for (const r of table) {
      ctx.out(r.map((cell, c) => (c === r.length - 1 && !rightAligned.has(c) ? cell : rightAligned.has(c) ? cell.padStart(widths[c]) : cell.padEnd(widths[c]))).join('  ').trimEnd() + '\n');
    }
    return 0;
  },
  help: {
    summary: 'show sockets (which ports are open, and who owns them)',
    usage: 'ss [-tulnp]',
    options: [
      ['-t / -u', 'TCP / UDP sockets'], ['-l', 'listening sockets only'], ['-n', 'numeric ports (do not translate 22 to ssh)'],
      ['-p', 'show the owning process (needs root to see other users\' processes)'], ['-a', 'all sockets'],
    ],
    notes: 'Only listening sockets are simulated. Column spacing differs slightly from the real tool.',
    examples: [['sudo ss -tlnp', 'the classic "what is listening on this box?" command']],
  },
};

export const proc = { ps, kill, ss };
