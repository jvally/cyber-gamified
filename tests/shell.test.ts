import { describe, expect, it } from 'vitest';
import { box } from './helpers';
import { dir, file } from '../src/levels/builders';

const A = { owner: 'analyst' };
const mk = () => box([
  file('/home/analyst/notes.txt', 'hello\nworld\n', A),
  file('/home/analyst/run.sh', '#!/bin/sh\n', { ...A, mode: 0o755 }),
  dir('/home/analyst/.ssh', { ...A, mode: 0o700 }),
  file('/home/analyst/.ssh/id_ed25519', 'KEY\n', { ...A, mode: 0o644 }),
  file('/root/secret', 'top\n', { mode: 0o600 }),
  file('/etc/app.conf', 'k=v\n'),
  dir('/srv/locked', { mode: 0o700 }),
  file('/srv/locked/f', 'x\n'),
], [{ pid: 3127, user: 'www-data', cmd: '/tmp/.cache/kworkerd -p 4444', listen: [{ proto: 'tcp', addr: '0.0.0.0', port: 4444 }] }]);

describe('pipes, redirects and operators', () => {
  it('pipes stdout but not stderr', () => {
    const r = mk().run('cat notes.txt missing | wc -l');
    expect(r.stdout).toBe('2\n');
    expect(r.stderr).toBe('cat: missing: No such file or directory\n');
    expect(r.code).toBe(0); // exit status of the last stage
  });
  it('2>&1 sends stderr down the pipe', () => expect(mk().out('cat notes.txt missing 2>&1 | wc -l')).toBe('3\n'));
  it('order of > and 2>&1 matters', () => {
    const b = mk();
    expect(b.out('cat missing > o 2>&1; cat o')).toBe('cat: missing: No such file or directory\n');
    expect(b.run('cat missing 2>&1 > o2').output).toBe('cat: missing: No such file or directory\n');
    expect(b.out('cat o2')).toBe('');
  });
  it('> truncates, >> appends, and both create files owned by the user', () => {
    const b = mk();
    b.run('echo a > f; echo b > f; echo c >> f');
    expect(b.out('cat f')).toBe('b\nc\n');
    expect(b.out('ls -l f')).toMatch(/^-rw-r--r-- 1 analyst analyst 4 Nov 15 09:00 f\n$/);
  });
  it('a failing redirect stops that command only', () => {
    const b = mk();
    const r = b.run('echo x > /etc/app.conf; echo next');
    expect(r.output).toBe('bash: /etc/app.conf: Permission denied\nnext\n');
    expect(b.state.vfs.readFile('/etc/app.conf')).toBe('k=v\n');
    expect(b.run('echo x > /nodir/f').output).toBe('bash: /nodir/f: No such file or directory\n');
    expect(b.run('echo x > /tmp').output).toBe('bash: /tmp: Is a directory\n');
    expect(b.run('cat < nope').output).toBe('bash: nope: No such file or directory\n');
  });
  it('sudo does not apply to redirects (the classic gotcha)', () => {
    const b = mk();
    expect(b.run('sudo echo pwned > /etc/app.conf').output).toBe('bash: /etc/app.conf: Permission denied\n');
    expect(b.run('sudo cp notes.txt /etc/app.conf').code).toBe(0);
    expect(b.state.vfs.readFile('/etc/app.conf')).toBe('hello\nworld\n');
  });
  it('/dev/null swallows output and reads as empty', () => {
    const b = mk();
    expect(b.run('cat notes.txt missing > /dev/null 2>&1').output).toBe('');
    expect(b.out('wc -l < /dev/null')).toBe('0\n');
    expect(b.state.vfs.readFile('/dev/null')).toBe('');
  });
  it('&& and || short-circuit; ; always continues', () => {
    const b = mk();
    expect(b.out('true && echo a || echo b')).toBe('a\n');
    expect(b.out('false && echo a || echo b')).toBe('b\n');
    expect(b.out('false; echo c')).toBe('c\n');
    expect(b.out('false || false || echo d')).toBe('d\n');
    expect(b.out('true || echo skipped && echo e')).toBe('e\n');
  });
  it('a redirect with no command creates an empty file', () => {
    const b = mk();
    b.run('> empty');
    expect(b.state.vfs.readFile('/home/analyst/empty')).toBe('');
  });
  it('long chains work', () => {
    expect(mk().out('cat notes.txt | grep -v zzz | sort -r | head -n 1 | cut -c1-3 | wc -c')).toBe('4\n');
  });
  it('reports syntax errors like bash and sets $? to 2', () => {
    const b = mk();
    expect(b.run('ls |').output).toBe("bash: syntax error near unexpected token `newline'\n");
    expect(b.out('echo $?')).toBe('2\n');
    expect(b.run('echo $(whoami)').output).toMatch(/^bash: command substitution is not supported/);
    expect(b.run('FOO=bar').output).toMatch(/variable assignment is not supported/);
  });
  it('unknown commands and paths', () => {
    const b = mk();
    expect(b.run('nmap -sS host')).toMatchObject({ stderr: 'bash: nmap: command not found\n', code: 127 });
    expect(b.run('./nope')).toMatchObject({ stderr: 'bash: ./nope: No such file or directory\n', code: 127 });
    expect(b.run('./notes.txt')).toMatchObject({ stderr: 'bash: ./notes.txt: Permission denied\n', code: 126 });
    expect(b.run('./run.sh').code).toBe(126);
    expect(b.run('constructor').code).toBe(127);
  });
  it('records history and blank lines are ignored', () => {
    const b = mk();
    b.run('pwd'); b.run('   '); b.run('ls');
    expect(b.out('history')).toBe('    1  pwd\n    2  ls\n    3  history\n');
  });
});

describe('cd / pwd', () => {
  it('navigates', () => {
    const b = mk();
    expect(b.out('pwd')).toBe('/home/analyst\n');
    b.run('cd /var/log');
    expect(b.out('pwd; echo $PWD $OLDPWD')).toBe('/var/log\n/var/log /home/analyst\n');
    expect(b.out('cd -')).toBe('/home/analyst\n');
    b.run('cd ..');
    expect(b.state.cwd).toBe('/home');
    b.run('cd');
    expect(b.state.cwd).toBe('/home/analyst');
    b.run('cd ~/.ssh');
    expect(b.out('ls')).toBe('id_ed25519\n');
  });
  it.each([
    ['cd /nope', 'bash: cd: /nope: No such file or directory\n'], ['cd notes.txt', 'bash: cd: notes.txt: Not a directory\n'],
    ['cd /root', 'bash: cd: /root: Permission denied\n'], ['cd a b', 'bash: cd: too many arguments\n'],
    ['cd -', 'bash: cd: OLDPWD not set\n'], ['sudo cd /root', 'sudo: cd: command not found\n'],
  ])('%s', (cmd, err) => expect(mk().run(cmd)).toMatchObject({ output: err, code: 1 }));
});

describe('sudo and identity', () => {
  it('runs one command as root', () => {
    const b = mk();
    expect(b.out('whoami; sudo whoami; whoami')).toBe('analyst\nroot\nanalyst\n');
    expect(b.out('sudo -u www-data whoami')).toBe('www-data\n');
    expect(b.run('cat /root/secret').output).toBe('cat: /root/secret: Permission denied\n');
    expect(b.out('sudo cat /root/secret')).toBe('top\n');
    expect(b.out('id')).toBe('uid=1000(analyst) gid=1000(analyst) groups=1000(analyst),27(sudo),4(adm)\n');
    expect(b.out('id www-data')).toBe('uid=33(www-data) gid=33(www-data) groups=33(www-data)\n');
  });
  it('errors', () => {
    const b = mk();
    expect(b.run('sudo').output).toMatch(/^usage: sudo/);
    expect(b.run('sudo nope').output).toBe('sudo: nope: command not found\n');
    expect(b.run('sudo -u ghost id').output).toBe('sudo: unknown user ghost\n');
    expect(b.run('id ghost').output).toBe("id: 'ghost': no such user\n");
    const w = box([], [], 'www-data');
    expect(w.run('sudo id').output).toBe('www-data is not in the sudoers file.\n');
  });
  it('sudo works inside pipelines and files created are root-owned', () => {
    const b = mk();
    expect(b.out('sudo cat /root/secret | wc -c')).toBe('4\n');
    b.run('sudo touch /etc/made');
    expect(b.state.vfs.get('/etc/made').owner).toBe('root');
  });
});

describe('help', () => {
  it('lists every command and explains each one', () => {
    const b = mk();
    const all = b.out('help');
    for (const name of Object.keys(b.sh.commands)) {
      expect(all).toContain(name);
      const one = b.run(`help ${name}`);
      expect(one.code).toBe(0);
      expect(one.output).toContain('Usage:');
    }
    expect(b.out('grep --help')).toBe(b.out('help grep'));
    expect(b.out('man chmod')).toBe(b.out('help chmod'));
    expect(b.run('help nope').code).toBe(1);
    expect(b.run('man').output).toMatch(/What manual page/);
  });
  it('echo --help is just text', () => expect(mk().out('echo --help')).toBe('--help\n'));
});

describe('game commands', () => {
  it('submit records answers', () => {
    const b = mk();
    expect(b.out('submit 203.0.113.5')).toBe('Answer submitted: 203.0.113.5\n');
    b.run('submit two words ');
    expect(b.state.submitted).toEqual(['203.0.113.5', 'two words']);
    expect(b.run('submit').code).toBe(1);
  });
  it('hook commands need the game', () => {
    const b = mk();
    expect(b.run('hint').output).toBe('hint: only available inside the game\n');
    b.state.game = { hint: () => 'try ls\n' };
    expect(b.out('hint')).toBe('try ls\n');
  });
});
