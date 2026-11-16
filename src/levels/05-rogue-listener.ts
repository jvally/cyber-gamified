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
  module: 'linux',
  title: 'An Unexpected Open Door',
  story: text(`
    A port scan of web01 shows one more open port than last week.
    Approved listeners are in ~/baseline-ports.txt. An unapproved one is often a backdoor.
    The site is live: stop only the rogue process.
  `),
  objective: 'Terminate the process listening on the port missing from the baseline. Keep legitimate services running.',
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
    return dead ? `You killed ${commName(dead.cmd)} (PID ${dead.pid}), a legitimate service. Confirm the PID before sending a signal.` : null;
  },
  hints: [
    '`ss` lists sockets. Compare the listening ports with ~/baseline-ports.txt.',
    '`ss -tln` shows listening TCP ports. `-p` adds the owning process but needs root for other users\' processes: `sudo ss -tlnp`.',
    'Port 4444 belongs to PID 3127, owned by another user: `sudo kill 3127`.',
  ],
  conceptCard: {
    attack: [
      'After gaining code execution, an attacker starts a listener to get back in later.',
      'It mimics a kernel thread name (kworker) and runs from a hidden directory in /var/tmp.',
    ],
    detection: [
      'Compare ss -tlnp against a baseline of approved ports.',
      'Check the owner, start time and binary path of the process.',
      'Real kernel threads show in [brackets] and have no binary path.',
    ],
    mitigation: [
      'Kill the process, keep the binary as evidence, then find the entry point and any persistence.',
      'Default-deny host firewall: an unapproved port stays unreachable.',
    ],
    commands: [
      { cmd: 'sudo ss -tlnp', explain: '-t TCP, -l listening, -n numeric, -p owning process (root sees all users)' },
      { cmd: 'ps aux | grep www-data', explain: 'all processes with owner and command line, filtered to one account' },
      { cmd: 'cat /proc/3127/cmdline', explain: 'how the process was started, straight from the kernel' },
      { cmd: 'sudo kill 3127', explain: 'SIGTERM to one PID; use -9 only if it ignores that' },
    ],
  },
  intel: 'The backdoor ran from /var/tmp. Verify nothing else was changed: compare against the baseline hashes.',
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
