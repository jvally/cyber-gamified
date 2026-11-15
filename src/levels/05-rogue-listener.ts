import { at, baseFiles, baseProcs, DAY, dir, file, text } from './builders';
import { commName } from '../sim/processes';
import type { ProcSpec } from '../sim/processes';
import type { Level } from './types';

const NOW = at('2026-11-18T09:00:00Z');
const ROGUE_PID = 3127;
const ROGUE_PORT = 4444;

const procs: ProcSpec[] = [
  ...baseProcs(),
  { pid: 801, user: 'root', cmd: 'nginx: master process /usr/sbin/nginx -g daemon on; master_process on;', listen: [{ proto: 'tcp', addr: '0.0.0.0', port: 80 }, { proto: 'tcp', addr: '0.0.0.0', port: 443 }] },
  { pid: 802, ppid: 801, user: 'www-data', cmd: 'nginx: worker process', stat: 'S' },
  { pid: 803, ppid: 801, user: 'www-data', cmd: 'nginx: worker process', stat: 'S' },
  { pid: 950, user: 'postgres', cmd: '/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main', listen: [{ proto: 'tcp', addr: '127.0.0.1', port: 5432 }] },
  { pid: 1204, ppid: 801, user: 'www-data', cmd: 'php-fpm: pool www', stat: 'S' },
  { pid: ROGUE_PID, user: 'www-data', cmd: '/var/tmp/.cache/kworkerd --listen 0.0.0.0:4444', start: '03:17', stat: 'Sl', cpu: 0.3, listen: [{ proto: 'tcp', addr: '0.0.0.0', port: ROGUE_PORT }] },
];
const PROTECTED = procs.filter((p) => p.pid !== ROGUE_PID);

export const rogueListener: Level = {
  id: 'rogue-listener',
  title: 'An Unexpected Open Door',
  story: text(`
    A routine external port scan of web01 came back with one port more than last week.
    Every open port is a program waiting for connections; an unexpected one usually means
    something was installed that nobody approved, often a backdoor.

    The approved listeners are documented in ~/baseline-ports.txt. Work out which process
    owns the extra port and stop it. The site is live: do not take down the real services.
  `),
  objective: 'Find the process listening on the port that is not in the baseline and terminate it, leaving every legitimate service running.',
  now: NOW,
  initialFS: [
    ...baseFiles(NOW),
    file('/home/analyst/baseline-ports.txt', text(`
      # web01 approved listening sockets (reviewed 2026-10-01)
      # port   bind address   service
      22       0.0.0.0        sshd
      80       0.0.0.0        nginx
      443      0.0.0.0        nginx
      5432     127.0.0.1      postgres (local only)
    `), { owner: 'analyst', mtime: NOW - 45 * DAY }),
    dir('/var/tmp/.cache', { owner: 'www-data', mode: 0o755, mtime: at('2026-11-18T03:17:00Z') }),
    file('/var/tmp/.cache/kworkerd', '\x7fELF (binary data)\n', { owner: 'www-data', mode: 0o755, mtime: at('2026-11-18T03:17:00Z') }),
    file('/usr/sbin/nginx', '\x7fELF (binary data)\n', { mode: 0o755, mtime: NOW - 200 * DAY }),
    file('/usr/sbin/sshd', '\x7fELF (binary data)\n', { mode: 0o755, mtime: NOW - 200 * DAY }),
  ],
  initialProcesses: procs,
  goalCheck: (s) => !s.procs.procs.some((p) => p.listen.some((l) => l.port === ROGUE_PORT)),
  failCheck: (s) => {
    const dead = PROTECTED.find((p) => !s.procs.get(p.pid));
    return dead ? `You killed ${commName(dead.cmd)} (PID ${dead.pid}), a legitimate service. On a production host that is an outage: identify the exact PID before sending a signal.` : null;
  },
  hints: [
    'You need two facts: which ports are open, and which process owns each one. `ss` lists sockets; compare its output with ~/baseline-ports.txt.',
    '`ss -tln` shows listening TCP ports. Add `-p` to see the owning process, but the kernel only reveals other users\' processes to root, so use `sudo ss -tlnp`. You can cross-check a PID with `ps aux` or `cat /proc/<pid>/cmdline`.',
    'The extra port is 4444, owned by PID 3127. It belongs to another user, so stopping it needs root: `sudo kill 3127`.',
  ],
  conceptCard: {
    attack: 'A backdoor listener (bind shell or implant). After getting code execution, here through the web application running as www-data, an attacker starts a program that listens on a port so they can come back later. It is often named to look like a kernel thread (kworker) and hidden in a dot-directory under a world-writable path such as /var/tmp.',
    detection: 'Compare listening sockets against a known baseline: ss -tlnp (or netstat -tlnp) shows port, address and owning PID. Then inspect the process: its user, start time, parent and binary path. Red flags here: an unprivileged service account, started at 03:17, running from a hidden directory, bound to all interfaces. Real kernel threads appear in [brackets] and have no binary path.',
    mitigation: 'Kill the process, but treat that as first aid: it is evidence of a compromise. Preserve the binary for analysis, find the entry point and any persistence (cron, systemd units, authorized_keys), and rebuild if in doubt. Prevent it with a default-deny host firewall, so an unapproved port is unreachable even if something listens on it.',
    commands: [
      { cmd: 'sudo ss -tlnp', explain: '-t TCP, -l listening, -n numeric ports, -p owning process (root needed to see other users\' processes)' },
      { cmd: 'ps aux | grep www-data', explain: 'list every process with owner and full command line, filtered to one account' },
      { cmd: 'cat /proc/3127/cmdline', explain: 'the kernel\'s own record of how a process was started' },
      { cmd: 'sudo kill 3127', explain: 'send SIGTERM to exactly one PID; -9 (SIGKILL) only if it ignores that' },
    ],
  },
  idealSolution: ['sudo ss -tlnp', `sudo kill ${ROGUE_PID}`],
  altSolutions: [
    ['cat baseline-ports.txt', 'ss -tln', 'ps aux | grep www-data', `cat /proc/${ROGUE_PID}/cmdline`, `sudo kill -9 ${ROGUE_PID}`],
    ['ps -ef | grep kworkerd', `sudo kill -TERM ${ROGUE_PID}`],
    ['sudo ss -tlnp | grep 4444', `sudo kill -s KILL ${ROGUE_PID}`],
  ],
  wrongSolutions: [
    [`kill ${ROGUE_PID}`], // not root: Operation not permitted
    ['sudo rm -r /var/tmp/.cache'], // deleting the file does not stop the running process
    ['sudo kill 802'], // a real nginx worker
    [`sudo kill ${ROGUE_PID} 801`],
    [`sudo kill -0 ${ROGUE_PID}`],
  ],
};
