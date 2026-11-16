import { describe, expect, it } from 'vitest';
import { ALL_LEVELS, AD_LEVELS, LEVELS, MODULES } from '../src/levels/index';
import { BASE_SCORE, createSession, Game, HINT_COSTS, MIN_SCORE, PAR_BONUS, runSolution } from '../src/levels/engine';
import type { LevelMeta } from '../src/levels/types';
import { registry } from '../src/shell/commands/index';
import { parse } from '../src/shell/parser';
import { parse as parsePs } from '../src/ad/powershell';
import { resolveCmdlet } from '../src/ad/cmdlets';
import { FAILED_COUNT } from '../src/levels/02-failed-logins';
import { NOISIEST_IP, TOP_IP } from '../src/levels/03-top-attacker';

const allSolutions = (l: LevelMeta): string[][] => [l.idealSolution, ...l.altSolutions];

/** Names of the commands a line would run, in the level's own shell syntax. */
function commandNames(level: LevelMeta, line: string): string[] {
  if (level.module === 'ad') return parsePs(line).flat().map((stage) => stage.name);
  return parse(line).flatMap((item) => item.pipeline.commands.map((cmd) => {
    const words = cmd.argv.map((w) => w.map((p) => p.text).join(''));
    return words[0] === 'sudo' ? words[1] : words[0];
  }));
}
const isKnown = (level: LevelMeta, name: string): boolean =>
  (level.module === 'ad' ? resolveCmdlet(name) !== undefined : Object.hasOwn(registry, name));
const HARMLESS: Record<LevelMeta['module'], string[]> = {
  linux: ['ls -la', 'pwd', 'help', 'ps aux', 'cat /etc/passwd', 'history'],
  ad: ['Get-ADUser -Filter *', 'help', 'Get-ADOrganizationalUnit -Filter *', 'Get-GPO -All', 'whoami', "Get-ADGroupMember 'Domain Admins'", 'Search-ADAccount -LockedOut'],
};
const BROKEN = /command not found|syntax error|not supported|is not recognized|cannot be found that matches|Missing/;

describe('level catalogue', () => {
  it('has the eight Linux levels in the planned order', () => {
    expect(LEVELS.map((l) => l.id)).toEqual([
      'leaked-env', 'failed-logins', 'top-attacker', 'private-key', 'rogue-listener', 'integrity', 'cron-persistence', 'base64-config',
    ]);
  });
  it('has the five Active Directory levels', () => {
    expect(AD_LEVELS.map((l) => l.id)).toEqual(['ad-account-recovery', 'ad-domain-admins', 'ad-stale-account', 'ad-ou-structure', 'ad-gpo-link']);
  });
  it('ids are unique and every level belongs to its module', () => {
    expect(new Set(ALL_LEVELS.map((l) => l.id)).size).toBe(ALL_LEVELS.length);
    for (const m of MODULES) for (const l of m.levels) expect(l.module).toBe(m.id);
  });
});

describe.each(ALL_LEVELS.map((l) => [l.id, l] as const))('level %s', (_id, level) => {
  it('is structurally complete', () => {
    for (const s of [level.title, level.story, level.objective, level.intel]) expect(s.trim().length).toBeGreaterThan(10);
    // keep the copy short: these limits stop the text creeping back into paragraphs
    expect(level.story.length).toBeLessThanOrEqual(320);
    expect(level.objective.length).toBeLessThanOrEqual(110);
    expect(level.intel.length).toBeLessThanOrEqual(130);
    level.hints.forEach((h) => expect(h.length).toBeLessThanOrEqual(190));
    expect(level.hints).toHaveLength(3);
    level.hints.forEach((h) => expect(h.length).toBeGreaterThan(20));
    const c = level.conceptCard;
    for (const points of [c.attack, c.detection, c.mitigation]) {
      expect(points.length).toBeGreaterThanOrEqual(2);
      expect(points.length).toBeLessThanOrEqual(3);
      points.forEach((p) => { expect(p.length).toBeGreaterThan(20); expect(p.length).toBeLessThanOrEqual(110); });
    }
    expect(c.commands.length).toBeGreaterThanOrEqual(2);
    c.commands.forEach((x) => { expect(x.cmd).not.toBe(''); expect(x.explain.length).toBeGreaterThan(10); expect(x.explain.length).toBeLessThanOrEqual(80); });
    expect(level.altSolutions.length, 'needs at least two valid solution paths').toBeGreaterThanOrEqual(1);
    expect(level.wrongSolutions?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('is not already solved (or failed) at the start', () => {
    const g = createSession(level);
    for (const harmless of HARMLESS[level.module]) {
      const r = g.exec(harmless);
      expect(r.status, harmless).toBe('playing');
      expect(r.code, harmless).toBe(0);
    }
  });

  it('ideal solution passes goalCheck through the real interpreter', () => {
    const { game, results } = runSolution(level, level.idealSolution);
    expect(game.status).toBe('won');
    expect(results[results.length - 1].justWon, 'the last command should be the one that wins').toBe(true);
    expect(results.slice(0, -1).every((r) => r.status === 'playing')).toBe(true);
    expect(game.score()).toBe(BASE_SCORE + PAR_BONUS);
  });

  it.each(level.altSolutions.map((s, i) => [i + 1, s] as const))('alternative solution %i passes', (_i, cmds) => {
    const { game, results } = runSolution(level, cmds);
    expect(game.status).toBe('won');
    expect(results.filter((r) => r.justWon)).toHaveLength(1);
  });

  it.each((level.wrongSolutions ?? []).map((s, i) => [i + 1, s] as const))('wrong solution %i does not pass', (_i, cmds) => {
    expect(runSolution(level, cmds).game.status).not.toBe('won');
  });

  it('solutions and concept-card commands use only supported commands and valid syntax', () => {
    const lines = [...allSolutions(level), ...(level.wrongSolutions ?? [])].flat().concat(level.conceptCard.commands.map((c) => c.cmd));
    for (const line of lines) for (const name of commandNames(level, line)) expect(isKnown(level, name), `${name} in: ${line}`).toBe(true);
  });

  it('solution commands run without errors', () => {
    for (const cmds of allSolutions(level)) {
      for (const r of runSolution(level, cmds).results) {
        expect(r.output).not.toMatch(BROKEN);
        // Unix tools legitimately exit non-zero (grep with no match, sha256sum -c on a mismatch); cmdlets should not fail
        if (level.module === 'ad') expect(r.code).toBe(0);
      }
    }
  });

  it('the third hint quotes commands that really work', () => {
    const hint = level.hints[2];
    const quoted = [...hint.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const plain = /Run: (.*)$/.exec(hint)?.[1];
    const cmds = [...quoted, ...(plain ? [plain] : [])].filter((c) => {
      const w = c.split(' ');
      return isKnown(level, w[0] === 'sudo' ? w[1] ?? '' : w[0]);
    });
    expect(cmds.length, 'tier-3 hints must name a concrete command').toBeGreaterThan(0);
    const { game, results } = runSolution(level, cmds);
    for (const r of results) expect(r.output).not.toMatch(/command not found|syntax error|No such file|is not recognized|Cannot find an object/);
    // levels solved by changing the machine (not by submitting an answer) are won by the hint alone
    if (!allSolutions(level).flat().some((c) => c.startsWith('submit'))) expect(game.status).toBe('won');
  });
});

describe('level-specific facts', () => {
  it('level 2: the shell agrees with the generator about the count', () => {
    const { results } = runSolution(LEVELS[1], ['grep -c "Failed password" /var/log/auth.log', 'grep "Failed password" /var/log/auth.log | wc -l']);
    expect(results.map((r) => r.output)).toEqual([`${FAILED_COUNT}\n`, `${FAILED_COUNT}\n`]);
    expect(FAILED_COUNT).toBe(61 + 34 + 19);
  });
  it('level 3: the noisiest address is not the top attacker', () => {
    expect(NOISIEST_IP).toBe('198.51.100.10');
    expect(TOP_IP).toBe('198.51.100.23');
    const { results } = runSolution(LEVELS[2], [LEVELS[2].idealSolution[0]]);
    expect(results[0].output.split('\n')[0]).toBe('    143 198.51.100.23');
  });
  it('level 4: the key really is unreadable to others afterwards', () => {
    const g = new Game(LEVELS[3]);
    expect(g.exec('sudo -u www-data cat /home/analyst/.ssh/id_ed25519').code).toBe(1); // blocked by ~ being 750
    g.exec('chmod 600 ~/.ssh/id_ed25519');
    expect(g.exec('ls -l ~/.ssh/id_ed25519').output).toMatch(/^-rw------- 1 analyst analyst /);
  });
  it('level 5: killing a legitimate service fails the level and blocks further play', () => {
    const g = new Game(LEVELS[4]);
    const r = g.exec('sudo kill 612');
    expect(r.justFailed).toBe(true);
    expect(g.failMessage).toMatch(/sshd \(PID 612\)/);
    expect(g.exec('sudo kill 3127').output).toMatch(/failed state/);
    expect(g.status).toBe('failed');
    g.reset();
    expect(g.status).toBe('playing');
    expect(g.exec('sudo kill 3127').justWon).toBe(true);
  });
  it('level 5: ss without sudo hides the owner, with sudo reveals it', () => {
    const g = new Game(LEVELS[4]);
    expect(g.exec('ss -tlnp | grep 4444').output).not.toMatch(/kworkerd/);
    expect(g.exec('sudo ss -tlnp | grep 4444').output).toMatch(/users:\(\("kworkerd",pid=3127/);
  });
  it('level 6: exactly one file fails verification and timestamps do not give it away', () => {
    const g = new Game(LEVELS[5]);
    const out = g.exec('sha256sum -c /opt/baseline/SHA256SUMS').output;
    expect(out.match(/: OK$/gm)).toHaveLength(4);
    expect(out).toContain('/usr/local/bin/healthcheck.sh: FAILED\n');
    expect(out).toContain('sha256sum: WARNING: 1 computed checksum did NOT match\n');
    expect(g.exec('ls -t /usr/local/bin').output.split('\n')[0]).toBe('deploy.sh');
  });
  it('level 7: needs root, and the legitimate jobs survive', () => {
    const g = new Game(LEVELS[6]);
    expect(g.exec('rm /etc/cron.d/system-update').output).toBe("rm: cannot remove '/etc/cron.d/system-update': Permission denied\n");
    expect(g.exec('ls /var/spool/cron/crontabs').code).toBe(2);
    expect(g.exec('ls -t /etc/cron.d').output.split('\n')[0]).toBe('system-update');
    expect(g.exec('sudo rm /etc/cron.d/system-update').justWon).toBe(true);
    expect(g.exec('ls /etc/cron.d').output).toBe('backup-db\ncertbot\nphp\nsysstat\n');
  });
  it('level 8: the decoded endpoint is what the level expects', () => {
    const g = new Game(LEVELS[7]);
    expect(g.exec('grep endpoint_b64 /opt/telemetry/agent.conf | cut -d= -f2- | base64 -d').output).toBe('https://c2.update-cdn.example/beacon');
    expect(g.exec('grep banner_b64 /opt/telemetry/agent.conf | cut -d= -f2 | base64 -d').output).toMatch(/base64: invalid input/);
  });
});

describe('game engine', () => {
  const level = LEVELS[3];
  it('scores: base + par bonus, minus hints, with a floor', () => {
    const g = new Game(level);
    expect(g.score()).toBe(BASE_SCORE + PAR_BONUS);
    expect(g.nextHint()).toMatchObject({ tier: 1, cost: HINT_COSTS[0], text: level.hints[0] });
    expect(g.score()).toBe(BASE_SCORE + PAR_BONUS - 10);
    g.nextHint(); g.nextHint();
    expect(g.nextHint()).toBeNull();
    expect(g.hintsUsed).toBe(3);
    expect(g.score()).toBe(BASE_SCORE + PAR_BONUS - 60);
    for (let i = 0; i <= g.par; i++) g.exec('pwd');
    expect(g.score()).toBe(BASE_SCORE - 60);
    expect(g.score()).toBeGreaterThanOrEqual(MIN_SCORE);
  });
  it('meta commands and blank lines are not counted', () => {
    const g = new Game(level);
    for (const c of ['help', 'help ls', 'man grep', 'history', 'clear', '', '   ']) g.exec(c);
    expect(g.commandCount).toBe(0);
    g.exec('ls'); g.exec('sudo whoami');
    expect(g.commandCount).toBe(2);
    expect(g.commands).toEqual(['ls', 'sudo whoami']);
  });
  it('flags wrong answers and keeps playing', () => {
    const g = new Game(LEVELS[0]);
    expect(g.exec('submit nope')).toMatchObject({ wrongAnswer: true, status: 'playing', justWon: false });
    expect(g.exec('submit AKIAIOSFODNN7EXAMPLE')).toMatchObject({ wrongAnswer: false, status: 'won', justWon: true });
    expect(g.exec('ls')).toMatchObject({ justWon: false, status: 'won' });
  });
  it('reset restores the initial machine', () => {
    const g = new Game(level);
    g.exec('rm -r ~/.ssh'); g.nextHint();
    expect(g.status).toBe('failed');
    g.reset();
    expect([g.status, g.hintsUsed, g.commandCount]).toEqual(['playing', 0, 0]);
    expect(g.exec('ls ~/.ssh').output).toBe('config\nid_ed25519\nid_ed25519.pub\nknown_hosts\n');
  });
  it('hooks are reachable from the shell', () => {
    const g = new Game(level, { hint: () => 'hinted\n', mission: () => 'brief\n' });
    expect(g.exec('hint').output).toBe('hinted\n');
    expect(g.exec('mission').output).toBe('brief\n');
    g.reset();
    expect(g.exec('hint').output).toBe('hinted\n');
  });
  it('levels are independent: state never leaks between games', () => {
    const a = new Game(level), b = new Game(level);
    a.exec('chmod 600 ~/.ssh/id_ed25519');
    expect([a.status, b.status]).toEqual(['won', 'playing']);
  });
});
