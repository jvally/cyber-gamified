import { at, baseFiles, baseProcs, DAY, file, text } from './builders';
import { genAuthLog } from './authlog';
import { lastAnswer } from './engine';
import type { Level } from './types';

const NOW = at('2026-11-15T09:00:00Z');
const LOG = genAuthLog({
  seed: 20261115, day: 'Nov 15', host: 'web01', hours: 9,
  attackers: [
    { ip: '203.0.113.42', attempts: 61, users: ['root', 'root', 'admin', 'ubuntu'] },
    { ip: '198.51.100.23', attempts: 34, users: ['root', 'oracle', 'test', 'postgres'] },
    { ip: '192.0.2.150', attempts: 19, users: ['root', 'pi', 'git'] },
  ],
  monitor: { ip: '198.51.100.10', user: 'deploy', everyMinutes: 30 },
});
export const FAILED_COUNT = LOG.failed;

export const failedLogins: Level = {
  id: 'failed-logins',
  module: 'linux',
  title: 'Knocking at the Door',
  story: text(`
    web01 exposes SSH to the internet and overnight alerts spiked.
    sshd logs every attempt in /var/log/auth.log. A failed attempt contains the exact text "Failed password".
    Other lines mention failure too (PAM, closed connections), so match precisely.
  `),
  objective: 'Count the "Failed password" lines in /var/log/auth.log and submit the number.',
  now: NOW,
  initialFS: [
    ...baseFiles(NOW),
    file('/var/log/auth.log', LOG.text, { owner: 'syslog', group: 'adm', mode: 0o640, mtime: NOW - 300 }),
    file('/var/log/auth.log.1', 'Nov 14 23:17:01 web01 CRON[901]: pam_unix(cron:session): session opened for user root(uid=0) by (uid=0)\nNov 14 23:17:01 web01 CRON[901]: pam_unix(cron:session): session closed for user root\n', { owner: 'syslog', group: 'adm', mode: 0o640, mtime: NOW - DAY }),
    file('/var/log/syslog', 'Nov 15 08:55:01 web01 systemd[1]: Started Session 41 of User analyst.\n', { owner: 'syslog', group: 'adm', mode: 0o640, mtime: NOW - 300 }),
  ],
  initialProcesses: baseProcs(),
  goalCheck: (s) => lastAnswer(s) === String(FAILED_COUNT),
  hints: [
    '`grep` keeps matching lines. Something else has to count them.',
    '`grep "Failed password" FILE | wc -l`, or `grep -c`. Avoid `-i`: it also matches PAM "authentication failure" lines.',
    '`grep -c "Failed password" /var/log/auth.log`, then submit the number.',
  ],
  conceptCard: {
    attack: [
      'Bots try common usernames and leaked passwords against every reachable SSH server.',
      'One weak password on one account is enough.',
    ],
    detection: [
      'Count "Failed password" lines in auth.log and watch the trend.',
      'Dangerous pattern: "Accepted password" right after many failures from one address.',
    ],
    mitigation: [
      'Keys only: PasswordAuthentication no, PermitRootLogin no.',
      'Ban repeat offenders with fail2ban.',
      'Limit who can reach port 22 (VPN or allow-list).',
    ],
    commands: [
      { cmd: 'grep "Failed password" /var/log/auth.log', explain: 'keep only failed password attempts' },
      { cmd: 'grep "Failed password" /var/log/auth.log | wc -l', explain: 'pipe the matches into wc to count lines' },
      { cmd: 'grep -c "Failed password" /var/log/auth.log', explain: 'grep counts matching lines itself' },
    ],
  },
  intel: 'That many failures is an attack, not typos. Find the address behind most of them.',
  idealSolution: ['grep -c "Failed password" /var/log/auth.log', `submit ${FAILED_COUNT}`],
  altSolutions: [
    ['grep "Failed password" /var/log/auth.log | wc -l', `submit ${FAILED_COUNT}`],
    ['cd /var/log', 'cat auth.log | grep Failed | wc -l', `submit ${FAILED_COUNT}`],
  ],
  wrongSolutions: [
    ['wc -l /var/log/auth.log', `submit ${LOG.text.split('\n').length - 1}`],
    ['grep -ic fail /var/log/auth.log', `submit ${(LOG.text.match(/^.*fail.*$/gim) ?? []).length}`],
  ],
};
