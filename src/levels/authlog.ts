// Deterministic generator for a realistic /var/log/auth.log.
import { prng } from './builders';

export interface Attacker { ip: string; attempts: number; users: string[] }
export interface AuthLogSpec {
  seed: number;
  /** syslog date prefix, e.g. "Nov 15" */
  day: string;
  host: string;
  attackers: Attacker[];
  /** a trusted host that logs in on a schedule (monitoring / deploys) */
  monitor?: { ip: string; user: string; everyMinutes: number };
  /** hours covered, starting at 00:00 */
  hours: number;
}
export interface AuthLog {
  text: string;
  /** number of "Failed password" lines */
  failed: number;
  /** "Failed password" lines per source IP */
  failedByIp: Map<string, number>;
  /** lines mentioning each IP at all */
  mentionsByIp: Map<string, number>;
}

const VALID_USERS = new Set(['root', 'analyst', 'postgres', 'www-data']);

export function genAuthLog(spec: AuthLogSpec): AuthLog {
  const rand = prng(spec.seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const span = spec.hours * 3600;
  const events: { t: number; lines: string[] }[] = [];
  let pid = 1100;
  const port = (): number => 32768 + Math.floor(rand() * 28000);

  for (const a of spec.attackers) {
    // attackers come in bursts
    const burstStart = Math.floor(rand() * span * 0.6);
    for (let i = 0; i < a.attempts; i++) {
      const t = Math.min(span - 1, burstStart + Math.floor((i / a.attempts) * span * 0.35) + Math.floor(rand() * 20));
      const user = pick(a.users);
      const p = port(), id = `sshd[${pid++}]`;
      const lines: string[] = [];
      if (VALID_USERS.has(user)) {
        if (rand() < 0.25) lines.push(`${id}: pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=${a.ip}  user=${user}`);
        lines.push(`${id}: Failed password for ${user} from ${a.ip} port ${p} ssh2`);
      } else {
        lines.push(`${id}: Invalid user ${user} from ${a.ip} port ${p}`);
        lines.push(`${id}: Failed password for invalid user ${user} from ${a.ip} port ${p} ssh2`);
      }
      if (rand() < 0.3) lines.push(`${id}: Connection closed by ${VALID_USERS.has(user) ? 'authenticating' : 'invalid'} user ${user} ${a.ip} port ${p} [preauth]`);
      if (rand() < 0.04) lines.push(`${id}: error: maximum authentication attempts exceeded for ${VALID_USERS.has(user) ? '' : 'invalid user '}${user} from ${a.ip} port ${p} ssh2 [preauth]`);
      events.push({ t, lines });
    }
  }
  if (spec.monitor) {
    const m = spec.monitor;
    for (let t = 45; t < span; t += m.everyMinutes * 60) {
      const p = port(), id = `sshd[${pid++}]`;
      events.push({ t: t + Math.floor(rand() * 5), lines: [
        `${id}: Accepted publickey for ${m.user} from ${m.ip} port ${p} ssh2: ED25519 SHA256:Zk3vJ0mB1xQe9uYt7pLwRa2cNd5hGs8fKiOj4XyTzU0`,
        `${id}: pam_unix(sshd:session): session opened for user ${m.user}(uid=998) by (uid=0)`,
        `${id}: Received disconnect from ${m.ip} port ${p}:11: disconnected by user`,
        `${id}: Disconnected from user ${m.user} ${m.ip} port ${p}`,
      ] });
    }
  }
  for (let t = 17 * 60; t < span; t += 3600) {
    const id = `CRON[${pid++}]`;
    events.push({ t, lines: [
      `${id}: pam_unix(cron:session): session opened for user root(uid=0) by (uid=0)`,
      `${id}: pam_unix(cron:session): session closed for user root`,
    ] });
  }
  events.push({ t: span - 300, lines: [
    `sshd[${pid++}]: Accepted publickey for analyst from 198.51.100.77 port ${port()} ssh2: ED25519 SHA256:pQ8rS1tUvWxYz2A3bC4dE5fG6hI7jK8lM9nO0pQrStU`,
    `sshd[${pid}]: pam_unix(sshd:session): session opened for user analyst(uid=1000) by (uid=0)`,
    'sudo:  analyst : TTY=pts/0 ; PWD=/home/analyst ; USER=root ; COMMAND=/usr/bin/tail -n 50 /var/log/syslog',
  ] });

  events.sort((a, b) => a.t - b.t);
  const stamp = (t: number): string =>
    [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map((n) => String(n).padStart(2, '0')).join(':');
  const out: string[] = [];
  const failedByIp = new Map<string, number>(), mentionsByIp = new Map<string, number>();
  let failed = 0;
  for (const e of events) {
    for (const l of e.lines) {
      out.push(`${spec.day} ${stamp(e.t)} ${spec.host} ${l}`);
      const ip = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(l)?.[1];
      if (ip) mentionsByIp.set(ip, (mentionsByIp.get(ip) ?? 0) + 1);
      if (l.includes('Failed password')) {
        failed++;
        if (ip) failedByIp.set(ip, (failedByIp.get(ip) ?? 0) + 1);
      }
    }
  }
  return { text: out.join('\n') + '\n', failed, failedByIp, mentionsByIp };
}
