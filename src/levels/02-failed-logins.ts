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
  title: 'Knocking at the Door',
  story: text(`
    web01 has SSH open to the internet, and the overnight alert volume looks odd.
    Every login attempt, successful or not, is recorded by sshd in /var/log/auth.log.
    Before anyone decides whether this is an incident, they need a number.

    A failed password attempt is logged as a line containing the exact text "Failed password".
    Other lines mention failures too (PAM messages, closed connections), so be precise.
  `),
  objective: 'Count the "Failed password" lines in /var/log/auth.log and submit the number (submit <count>).',
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
    'The log is far too long to count by eye. `grep` prints only the lines that match a pattern; something else can count lines.',
    'Filter with `grep "Failed password" /var/log/auth.log`, then count: pipe into `wc -l`, or let grep count with `-c`. Mind the capital F; `-i` would also match the PAM "authentication failure" lines and over-count.',
    'Run `grep -c "Failed password" /var/log/auth.log` and submit the number it prints.',
  ],
  conceptCard: {
    attack: 'Password guessing against SSH (brute force / credential stuffing). Bots try common usernames and leaked passwords against every reachable SSH server, around the clock. One weak password on one account is enough.',
    detection: 'sshd logs every attempt to /var/log/auth.log (or the systemd journal). Counting "Failed password" lines, and watching the count over time, separates background noise from a targeted attack. A success ("Accepted password") right after many failures from the same address is the pattern to fear.',
    mitigation: 'Disable password logins and use keys (PasswordAuthentication no), forbid direct root login, and rate-limit or ban repeat offenders with fail2ban or firewall rules. Restrict who can reach port 22 at all with a VPN or allow-list.',
    commands: [
      { cmd: 'grep "Failed password" /var/log/auth.log', explain: 'keep only the lines that record a failed password attempt' },
      { cmd: 'grep "Failed password" /var/log/auth.log | wc -l', explain: 'pipe the matching lines into wc, which counts them' },
      { cmd: 'grep -c "Failed password" /var/log/auth.log', explain: 'grep can count matching lines itself' },
    ],
  },
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
