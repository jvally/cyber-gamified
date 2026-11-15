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
    The failed logins kept coming last night. The firewall team can block one address
    right now, but they want the one that matters most: the source of the most failed
    password attempts.

    Careful: the log also records plenty of legitimate logins. The busiest address in the
    file is not necessarily the attacker.
  `),
  objective: 'Submit the IP address behind the most "Failed password" lines in /var/log/auth.log (submit <ip>).',
  now: NOW,
  initialFS: [
    ...baseFiles(NOW),
    file('/var/log/auth.log', LOG.text, { owner: 'syslog', group: 'adm', mode: 0o640, mtime: NOW - 300 }),
    file('/home/analyst/allowlist.txt', '# known-good sources\n198.51.100.10   deploy/monitoring host\n198.51.100.77   analyst VPN exit\n', { owner: 'analyst' }),
  ],
  initialProcesses: baseProcs(),
  goalCheck: (s) => lastAnswer(s) === TOP_IP,
  hints: [
    'This is a counting problem in three steps: keep the failed-login lines, pull out just the IP address from each, then count how often each address appears.',
    '`sort | uniq -c` turns a list into a frequency table (uniq only merges adjacent lines, hence the sort). `sort -rn` then puts the biggest count first. To isolate the address, `grep -o` prints only the part of the line that matched.',
    `Run: grep "Failed password" /var/log/auth.log | grep -oE "${IP_RE}" | sort | uniq -c | sort -rn | head -n 3`,
  ],
  conceptCard: {
    attack: 'A brute-force campaign is rarely evenly spread: a few sources produce most of the attempts. Attackers also hide in the noise of legitimate traffic, so raw volume alone is misleading.',
    detection: 'Aggregate, do not eyeball. Filter to the event you care about first (failed logins), extract one field (source address), then build a frequency table. The pipeline grep | sort | uniq -c | sort -rn is the standard way to answer "what are the top N ...?" from any text log.',
    mitigation: 'Block or rate-limit the top offenders (fail2ban automates exactly this pipeline), but treat that as a stopgap: addresses are cheap to change. The durable fixes are key-only authentication and not exposing SSH to the whole internet.',
    commands: [
      { cmd: 'grep "Failed password" /var/log/auth.log', explain: 'filter first, so legitimate logins are not counted' },
      { cmd: `grep -oE "${IP_RE}"`, explain: '-o prints only the matched text; -E enables {1,3} repetition without backslashes' },
      { cmd: 'sort | uniq -c', explain: 'sort groups identical lines together; uniq -c collapses each group and prefixes its count' },
      { cmd: 'sort -rn | head -n 3', explain: 'numeric sort, largest first, then keep the top three' },
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
