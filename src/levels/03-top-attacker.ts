import { at, baseFiles, baseProcs, file, text } from './builders';
import { genAuthLog } from './authlog';
import { lastAnswer } from './engine';
import type { Level } from './types';

const NOW = at('2026-11-16T09:00:00Z');
const LOG = genAuthLog({
  seed: 31337, day: 'Nov 16', host: 'web01', hours: 9,
  attackers: [
    { ip: '203.0.113.42', attempts: 58, users: ['root', 'admin', 'ubuntu', 'test'] },
    { ip: '198.51.100.23', attempts: 143, users: ['root', 'root', 'root', 'oracle', 'postgres'] },
    { ip: '192.0.2.150', attempts: 97, users: ['root', 'pi', 'git', 'deploy'] },
    { ip: '203.0.113.9', attempts: 12, users: ['admin', 'guest'] },
    { ip: '192.0.2.61', attempts: 3, users: ['root'] },
  ],
  monitor: { ip: '198.51.100.10', user: 'deploy', everyMinutes: 3 },
});
const ranked = [...LOG.failedByIp].sort((a, b) => b[1] - a[1]);
export const TOP_IP = ranked[0][0];
/** the address that appears on the most lines overall: the (innocent) monitoring host */
export const NOISIEST_IP = [...LOG.mentionsByIp].sort((a, b) => b[1] - a[1])[0][0];

const IP_RE = '([0-9]{1,3}\\.){3}[0-9]{1,3}';

export const topAttacker: Level = {
  id: 'top-attacker',
  title: 'Who Is Knocking Loudest?',
  story: text(`
    The firewall team can block one address now: the source of the most failed password attempts.
    The log also holds legitimate logins, so the busiest address overall is not necessarily the attacker.
  `),
  objective: 'Submit the IP address with the most "Failed password" lines in /var/log/auth.log.',
  now: NOW,
  initialFS: [
    ...baseFiles(NOW),
    file('/var/log/auth.log', LOG.text, { owner: 'syslog', group: 'adm', mode: 0o640, mtime: NOW - 300 }),
    file('/home/analyst/allowlist.txt', '# known-good sources\n198.51.100.10   deploy/monitoring host\n198.51.100.77   analyst VPN exit\n', { owner: 'analyst' }),
  ],
  initialProcesses: baseProcs(),
  goalCheck: (s) => lastAnswer(s) === TOP_IP,
  hints: [
    'Three steps: keep the failed lines, extract the IP from each, count per IP.',
    '`grep -o` prints only the matched text. `sort | uniq -c` builds a frequency table; `sort -rn` puts the biggest first.',
    `Run: grep "Failed password" /var/log/auth.log | grep -oE "${IP_RE}" | sort | uniq -c | sort -rn | head -n 3`,
  ],
  conceptCard: {
    attack: [
      'A few sources produce most brute-force attempts.',
      'Attack traffic hides among legitimate logins, so total volume misleads.',
    ],
    detection: [
      'Filter to the event first (failed logins), then extract one field and count it.',
      'grep | sort | uniq -c | sort -rn answers "top N" for any text log.',
    ],
    mitigation: [
      'Block or rate-limit the top sources; fail2ban automates this pipeline.',
      'Addresses are cheap to change: key-only login is the durable fix.',
    ],
    commands: [
      { cmd: 'grep "Failed password" /var/log/auth.log', explain: 'filter first, so legitimate logins are not counted' },
      { cmd: `grep -oE "${IP_RE}"`, explain: '-o prints only the match; -E allows {1,3} without backslashes' },
      { cmd: 'sort | uniq -c', explain: 'uniq -c counts adjacent duplicates, so sort first' },
      { cmd: 'sort -rn | head -n 3', explain: 'numeric sort, largest first, top three' },
    ],
  },
  idealSolution: [
    `grep "Failed password" /var/log/auth.log | grep -oE "${IP_RE}" | sort | uniq -c | sort -rn | head -n 3`,
    `submit ${TOP_IP}`,
  ],
  altSolutions: [
    [
      'grep "Failed password" /var/log/auth.log | grep -o "from [0-9.]*" | cut -d" " -f2 | sort | uniq -c | sort -n | tail -n 1',
      `submit ${TOP_IP}`,
    ],
    [
      'cd /var/log',
      'grep "Failed password" auth.log > /tmp/failed.txt',
      `grep -oE "${IP_RE}" /tmp/failed.txt | sort | uniq -c | sort -k1,1nr | head -1`,
      `submit ${TOP_IP}`,
    ],
  ],
  wrongSolutions: [
    // counting every line that mentions an address finds the monitoring host instead
    [`grep -oE "${IP_RE}" /var/log/auth.log | sort | uniq -c | sort -rn | head -n 1`, `submit ${NOISIEST_IP}`],
    // forgetting to sort before uniq, then trusting the first line
    [`submit ${ranked[1][0]}`],
  ],
};
