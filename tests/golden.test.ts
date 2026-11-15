// Compares the simulator against the real GNU tools on this machine (skipped where they are absent).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { box, Box } from './helpers';
import { dir as mkDir, file } from '../src/levels/builders';

const FILES: Record<string, string> = {
  'fruits.txt': 'banana\napple\nCherry\napple\nbanana\napple\ndate\n',
  'nums.txt': '10\n9\n100\n-5\n3.5\n9\nabc\n',
  'noeol.txt': 'one\ntwo\nthree',
  'empty.txt': '',
  'csv.txt': 'id,name,role\n1,alice,admin\n2,bob,user\n3,carol,user\nno delimiter here\n',
  'tabs.txt': 'a\tb\tc\n1\t2\t3\n',
  'auth.log': [
    'Nov 15 03:12:01 web01 sshd[1201]: Failed password for root from 203.0.113.5 port 51234 ssh2',
    'Nov 15 03:12:04 web01 sshd[1201]: Failed password for invalid user admin from 203.0.113.5 port 51236 ssh2',
    'Nov 15 03:13:10 web01 sshd[1210]: Accepted publickey for analyst from 198.51.100.10 port 40022 ssh2',
    'Nov 15 03:14:55 web01 sshd[1222]: Failed password for root from 192.0.2.77 port 39001 ssh2',
    'Nov 15 03:15:02 web01 sshd[1222]: Failed password for root from 203.0.113.5 port 51240 ssh2',
    'Nov 15 03:16:40 web01 CRON[1301]: pam_unix(cron:session): session opened for user root(uid=0)',
    '',
  ].join('\n'),
  'sizes.txt': '2K\n1G\n512\n10M\n',
  'kv.txt': 'b 2\na 10\nc 1\na 2\n',
  'sub/inner.txt': 'needle in sub\nhay\n',
  'sub/deep/x.log': 'another needle\n',
  'words.txt': 'The quick brown fox\njumps over the lazy dog\n\nthe end\n',
  'b64.txt': 'aGVsbG8gd29ybGQK\n',
};

const CASES: string[] = [
  // cat / head / tail
  'cat fruits.txt', 'cat -n fruits.txt', 'cat -n words.txt', 'cat -b words.txt', 'cat noeol.txt fruits.txt', 'cat missing.txt', 'cat sub',
  'cat fruits.txt missing.txt nums.txt', 'head -n 3 fruits.txt', 'head -3 fruits.txt', 'head -n -2 fruits.txt', 'head -c 5 fruits.txt',
  'head -n 2 fruits.txt nums.txt', 'head fruits.txt', 'head -n 0 fruits.txt', 'head noeol.txt', 'head -n 2 missing.txt fruits.txt',
  'tail -n 2 fruits.txt', 'tail -2 fruits.txt', 'tail -n +3 fruits.txt', 'tail -c 6 fruits.txt', 'tail noeol.txt', 'tail -n 1 fruits.txt nums.txt',
  'head -n abc fruits.txt', 'tail -q -n 1 fruits.txt nums.txt',
  // grep
  'grep apple fruits.txt', 'grep -c apple fruits.txt', 'grep -n an fruits.txt', 'grep -v apple fruits.txt', 'grep -i cherry fruits.txt',
  'grep -o an fruits.txt', 'grep nope fruits.txt', 'grep apple missing.txt', 'grep apple fruits.txt nums.txt', 'grep -c a fruits.txt nums.txt',
  'grep -h apple fruits.txt nums.txt', 'grep -H apple fruits.txt', 'grep -l a fruits.txt nums.txt csv.txt', 'grep -L a fruits.txt nums.txt csv.txt',
  'grep -w the words.txt', 'grep -x apple fruits.txt', 'grep -E "apple|date" fruits.txt', 'grep "apple\\|date" fruits.txt', 'grep "apple|date" fruits.txt',
  'grep -F "3.5" nums.txt', 'grep "3.5" nums.txt', 'grep "^a" fruits.txt', 'grep "e$" fruits.txt', 'grep -E "^[0-9]+$" nums.txt',
  'grep "[[:digit:]]" nums.txt', 'grep -c "Failed password" auth.log', 'grep -oE "([0-9]{1,3}\\.){3}[0-9]{1,3}" auth.log',
  'grep -o "from [0-9.]*" auth.log', 'grep -m 2 Failed auth.log', 'grep -A1 Accepted auth.log', 'grep -B1 -n Accepted auth.log',
  'grep -C1 date fruits.txt', 'grep -A1 apple fruits.txt', 'grep -q apple fruits.txt', 'grep -q nope fruits.txt', 'grep',
  'grep apple sub', 'grep -e apple -e date fruits.txt', 'grep -ic APPLE fruits.txt', 'grep -vc apple fruits.txt', 'grep "a*" empty.txt',
  'grep -E "an+" fruits.txt', 'grep "an\\+" fruits.txt', 'grep "an+" fruits.txt', 'grep -E "(an){2}" fruits.txt', 'grep "\\(an\\)\\{2\\}" fruits.txt',
  'grep "[" fruits.txt', 'grep -on "a" fruits.txt', 'grep -s apple missing.txt', 'grep "\\<the\\>" words.txt', 'grep -n "" words.txt',
  // sort / uniq
  'sort fruits.txt', 'sort -r fruits.txt', 'sort -u fruits.txt', 'sort -f fruits.txt', 'sort -n nums.txt', 'sort -rn nums.txt', 'sort nums.txt',
  'sort -nu nums.txt', 'sort -h sizes.txt', 'sort -k2 kv.txt', 'sort -k2n kv.txt', 'sort -k2,2nr kv.txt', 'sort -k1,1 -k2,2n kv.txt',
  'sort -t, -k2 csv.txt', 'sort -t, -k3,3 -k2,2r csv.txt', 'sort fruits.txt nums.txt', 'sort missing.txt', 'sort noeol.txt', 'sort -k 2 -r kv.txt',
  'uniq fruits.txt', 'sort fruits.txt | uniq', 'sort fruits.txt | uniq -c', 'sort fruits.txt | uniq -d', 'sort fruits.txt | uniq -u',
  'sort fruits.txt | uniq -c | sort -rn', 'sort fruits.txt | uniq -c | sort -rn | head -n 1', 'sort -f fruits.txt | uniq -ci', 'sort fruits.txt | uniq -cd',
  // wc
  'wc fruits.txt', 'wc -l fruits.txt', 'wc -w words.txt', 'wc -c fruits.txt', 'wc -lc fruits.txt', 'wc fruits.txt nums.txt', 'wc -l fruits.txt nums.txt auth.log',
  'cat fruits.txt | wc -l', 'cat fruits.txt | wc', 'cat fruits.txt | wc -lw', 'wc noeol.txt', 'wc -l missing.txt', 'wc empty.txt', 'wc -l missing.txt fruits.txt',
  'wc -m fruits.txt',
  // cut
  'cut -d, -f2 csv.txt', 'cut -d, -f1,3 csv.txt', 'cut -d, -f2- csv.txt', 'cut -d, -f-2 csv.txt', 'cut -d, -f2 -s csv.txt', 'cut -f2 tabs.txt',
  'cut -c1-3 fruits.txt', 'cut -c2 fruits.txt', 'cut -c3- fruits.txt', 'cut -d" " -f11 auth.log', 'cut -d" " -f1-3 auth.log', 'cut -d, -f3,1 csv.txt',
  'cut fruits.txt', 'cut -d, csv.txt', 'cut -d,, -f1 csv.txt', 'cut -f0 csv.txt', 'cut -d, -f2,2 csv.txt', 'cut -d, -f9 csv.txt', 'cut -c 1,3 fruits.txt',
  // echo / base64 / sha256sum
  'echo hello world', 'echo -n hi', 'echo -e "a\\tb\\nc"', 'echo "a   b"   c', "echo 'single $HOME'", 'echo -e "x\\x41\\0101"', 'echo', 'echo -n',
  'echo "tab\\there"', 'echo a;echo b', 'echo -e "stop\\chere"', 'echo -- -n', 'echo -x',
  'echo hello | base64', 'echo -n hello | base64', 'base64 fruits.txt', 'base64 -w 20 fruits.txt', 'base64 -w 0 fruits.txt', 'base64 -d b64.txt',
  'echo aGVsbG8= | base64 -d', 'echo "aGVs bG8=" | base64 -d', 'echo "!!!" | base64 -d', 'echo aGVsbG8 | base64 -d', 'base64 auth.log',
  'echo "aGVs bG8=" | base64 -di', 'base64 missing.txt', 'base64 -d empty.txt',
  'sha256sum fruits.txt', 'sha256sum empty.txt', 'sha256sum fruits.txt nums.txt', 'echo -n abc | sha256sum', 'sha256sum missing.txt', 'sha256sum sub',
  'sha256sum fruits.txt nums.txt > sums; sha256sum -c sums', 'sha256sum fruits.txt nums.txt > sums; echo x >> nums.txt; sha256sum -c sums',
  'sha256sum auth.log words.txt',
  // find (sorted, since real find uses directory order)
  'find . | sort', 'find . -name "*.txt" | sort', 'find . -type d | sort', 'find sub -type f | sort', 'find . -name "*.log" | sort', 'find . -iname "FRUITS*"',
  'find . -maxdepth 1 -name "*.txt" | sort', 'find . -mindepth 2 | sort', 'find . -name fruits.txt -o -name nums.txt | sort', 'find . ! -name "*.txt" | sort',
  'find missing', 'find . -name', 'find . -bogus', 'find . -empty | sort', 'find . -size +0 -name "*.txt" | sort', 'find . -path "./sub/*" | sort',
  'find . -type f -name "*.log" -exec wc -l {} \\; | sort', 'find sub/ -name "*.txt"', 'find . -size -2c -type f | sort', 'find . -type f -size +100c | sort',
  'find . \\( -name "*.log" -o -name "kv*" \\) -type f | sort', 'find sub -type f -exec grep -l needle {} + | sort',
  // pipelines, redirects, quoting, operators
  'grep "Failed password" auth.log | cut -d" " -f11 | sort | uniq -c | sort -rn', 'grep Failed auth.log | wc -l',
  'grep "Failed password" auth.log | grep -oE "([0-9]{1,3}\\.){3}[0-9]{1,3}" | sort | uniq -c | sort -rn | head -n 1',
  'cat fruits.txt | sort | uniq -c | sort -k1,1nr -k2 | head -2', 'echo a > out.txt; echo b >> out.txt; cat out.txt', 'sort < fruits.txt | head -1',
  'cat missing.txt 2> err.txt; cat err.txt', 'cat missing.txt fruits.txt > both.txt 2>&1; cat both.txt', 'cat missing.txt 2>/dev/null; echo $?',
  'true && echo yes', 'false && echo yes', 'false || echo no', 'true || echo no', 'false; echo $?', 'grep -q apple fruits.txt && echo found',
  'echo *.log', 'echo sub/*', 'echo nomatch*', 'echo "*.log"', 'echo f*.txt n?ms.txt', 'echo [a-c]*.txt', 'echo sub/*/*.log', 'echo \\*.log',
  'cat fruits.txt | grep a | grep -v b | wc -l', 'sort fruits.txt > fruits.txt; wc -c fruits.txt', 'echo one two | cut -d" " -f2',
  "echo 'it''s' \"dq 'x'\" a\\ b", 'echo "a"b\'c\'d', 'echo # comment', 'echo a#b', 'wc -l < fruits.txt', 'cat < missing.txt',
  'echo hi | cat - fruits.txt | head -n 2', 'grep -c a < fruits.txt', 'cat fruits.txt nums.txt | sort -u | wc -l', 'echo x | cat missing.txt 2>&1 | wc -l',
  'tail -n +2 csv.txt | cut -d, -f3 | sort | uniq -c', 'head -n 5 auth.log | tail -n 2 | cut -c1-15',
];

const hasGnu = ((): boolean => {
  try { return /GNU/.test(execFileSync('sort', ['--version'], { encoding: 'utf8' })); } catch { return false; }
})();

describe.skipIf(!hasGnu)('golden: simulator output matches real GNU tools', () => {
  let dir: string;
  const fresh = (): Box => {
    const b = box([
      mkDir('/home/analyst/g', { owner: 'analyst' }),
      ...Object.entries(FILES).map(([p, c]) => file(`/home/analyst/g/${p}`, c, { owner: 'analyst' })),
    ]);
    for (const d of ['/home/analyst/g/sub', '/home/analyst/g/sub/deep']) b.state.vfs.get(d).owner = 'analyst';
    b.state.cwd = '/home/analyst/g';
    return b;
  };
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'shellshock-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(CASES)('%s', (cmd) => {
    const cwd = mkdtempSync(join(dir, 'c'));
    for (const [p, c] of Object.entries(FILES)) {
      mkdirSync(join(cwd, p, '..'), { recursive: true });
      writeFileSync(join(cwd, p), c);
    }
    const real = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C', HOME: '/home/analyst' } });
    const sim = fresh().run(cmd);
    const norm = (s: string): string => s.replace(/^bash: line \d+: /gm, 'bash: ');
    expect({ stdout: sim.stdout, stderr: sim.stderr, code: sim.code })
      .toEqual({ stdout: real.stdout, stderr: norm(real.stderr), code: real.status });
  });
});
