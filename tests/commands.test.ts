import { describe, expect, it } from 'vitest';
import { box, NOW } from './helpers';
import { DAY, dir, file } from '../src/levels/builders';
import { humanSize, lsDate } from '../src/shell/commands/ls';

const A = { owner: 'analyst' };
const mk = (user = 'analyst') => box([
  file('/home/analyst/notes.txt', 'hello\nworld\n', A),
  file('/home/analyst/run.sh', '#!/bin/sh\n', { ...A, mode: 0o755 }),
  file('/home/analyst/Zed', 'z', A),
  file('/home/analyst/old.log', 'x'.repeat(5000), { ...A, mtime: NOW - 400 * DAY }),
  dir('/home/analyst/.ssh', { ...A, mode: 0o700 }),
  file('/home/analyst/.ssh/id_ed25519', 'KEY\n', { ...A, mode: 0o644 }),
  file('/home/analyst/.ssh/id_ed25519.pub', 'PUB\n', { ...A, mode: 0o644 }),
  dir('/home/analyst/proj/src', A), dir('/home/analyst/proj', A),
  file('/home/analyst/proj/src/main.c', 'int main(){}\n', A),
  file('/home/analyst/proj/README', 'TODO: password=hunter2\n', A),
  file('/root/secret', 'top\n', { mode: 0o600 }),
  file('/etc/app.conf', 'k=v\n', { mtime: NOW - 2 * 3600 }),
  file('/usr/bin/passwd', 'ELF', { mode: 0o4755 }),
  file('/usr/bin/tool', 'ELF', { mode: 0o755 }),
  file('/var/www/upload/shell.php', '<?php ?>\n', { owner: 'www-data', mode: 0o666, mtime: NOW - 600 }),
  dir('/srv/locked', { mode: 0o700 }), file('/srv/locked/f', 'x\n'),
], [
  { pid: 801, user: 'root', cmd: 'nginx: master process /usr/sbin/nginx', listen: [{ proto: 'tcp', addr: '0.0.0.0', port: 80 }, { proto: 'tcp', addr: '0.0.0.0', port: 443 }] },
  { pid: 802, ppid: 801, user: 'www-data', cmd: 'nginx: worker process', stat: 'S' },
  { pid: 3127, user: 'www-data', cmd: '/tmp/.cache/kworkerd -p 4444', listen: [{ proto: 'tcp', addr: '0.0.0.0', port: 4444 }] },
  { pid: 3300, user: 'analyst', cmd: 'sleep 600', tty: 'pts/0', stat: 'S' },
  { pid: 950, user: 'postgres', cmd: '/usr/lib/postgresql/16/bin/postgres', listen: [{ proto: 'tcp', addr: '127.0.0.1', port: 5432 }] },
], user);

describe('ls', () => {
  it('plain listing hides dotfiles and sorts in byte order (uppercase first)', () => {
    expect(mk().out('ls')).toBe('Zed\nnotes.txt\nold.log\nproj\nrun.sh\n');
  });
  it('-a and -A', () => {
    expect(mk().out('ls -a .ssh')).toBe('.\n..\nid_ed25519\nid_ed25519.pub\n');
    expect(mk().out('ls -A').split('\n').slice(0, 3)).toEqual(['.bashrc', '.profile', '.ssh']);
  });
  it('-l shows mode, links, owner, group, size, date; old files show the year', () => {
    expect(mk().out('ls -l')).toBe([
      'total 24',
      '-rw-r--r-- 1 analyst analyst    1 Nov 15 09:00 Zed',
      '-rw-r--r-- 1 analyst analyst   12 Nov 15 09:00 notes.txt',
      '-rw-r--r-- 1 analyst analyst 5000 Oct 11  2025 old.log',
      'drwxr-xr-x 3 analyst analyst 4096 Nov 15 09:00 proj',
      '-rwxr-xr-x 1 analyst analyst   10 Nov 15 09:00 run.sh',
      '',
    ].join('\n'));
  });
  it('-la includes . and .. and column-aligns owners of different length', () => {
    const out = mk().out('ls -la /var/www/upload');
    expect(out).toBe([
      'total 12',
      'drwxr-xr-x 2 root     root     4096 Nov 15 09:00 .',
      'drwxr-xr-x 3 root     root     4096 Jul 18 09:00 ..',
      '-rw-rw-rw- 1 www-data www-data    9 Nov 15 08:50 shell.php',
      '',
    ].join('\n'));
  });
  it('-d, -h, -t, -S, -r, special bits', () => {
    const b = mk();
    expect(b.out('ls -ld /tmp .ssh')).toBe('drwx------ 2 analyst analyst 4096 Nov 15 09:00 .ssh\ndrwxrwxrwt 2 root    root    4096 Nov 15 08:00 /tmp\n');
    expect(b.out('ls -lh old.log')).toMatch(/ 4\.9K Oct 11 {2}2025 old\.log\n$/);
    expect(b.out('ls -l /usr/bin/passwd')).toMatch(/^-rwsr-xr-x 1 root root 3 /);
    expect(b.out('ls -t').split('\n').pop()).toBe('');
    expect(b.out('ls -t').trim().split('\n').pop()).toBe('old.log');
    expect(b.out('ls -S').split('\n')[0]).toBe('old.log');
    expect(b.out('ls -r').split('\n')[0]).toBe('run.sh');
    expect(b.out('ls -1 notes.txt Zed')).toBe('Zed\nnotes.txt\n');
  });
  it('multiple operands and -R print headers', () => {
    const b = mk();
    expect(b.out('ls proj .ssh')).toBe('.ssh:\nid_ed25519\nid_ed25519.pub\n\nproj:\nREADME\nsrc\n');
    expect(b.out('ls -R proj')).toBe('proj:\nREADME\nsrc\n\nproj/src:\nmain.c\n');
    expect(b.out('ls notes.txt proj')).toBe('notes.txt\n\nproj:\nREADME\nsrc\n');
  });
  it('errors', () => {
    const b = mk();
    expect(b.run('ls nope')).toMatchObject({ stderr: "ls: cannot access 'nope': No such file or directory\n", code: 2 });
    expect(b.run('ls /root')).toMatchObject({ stderr: "ls: cannot open directory '/root': Permission denied\n", code: 2 });
    expect(b.run('ls /srv/locked/f')).toMatchObject({ stderr: "ls: cannot access '/srv/locked/f': Permission denied\n", code: 2 });
    expect(b.run('ls -z')).toMatchObject({ stderr: "ls: invalid option -- 'z'\nTry 'ls --help' for more information.\n", code: 2 });
    expect(b.run('ls nope notes.txt').output).toBe("ls: cannot access 'nope': No such file or directory\nnotes.txt\n");
    expect(b.out('sudo ls /root')).toBe('secret\n');
  });
  it('column layout and colours on a terminal', () => {
    const b = mk();
    const r = b.sh.run('ls', { tty: true, cols: 40 });
    expect(r.output).toBe('Zed  notes.txt  old.log  \x1b[1;34mproj\x1b[0m  \x1b[1;32mrun.sh\x1b[0m\n');
    const narrow = b.sh.run('ls', { tty: true, cols: 20 }).output.replace(/\x1b\[[0-9;]*m/g, '');
    expect(narrow).toBe('Zed        proj\nnotes.txt  run.sh\nold.log\n');
  });
  it('helpers', () => {
    expect([humanSize(0), humanSize(1023), humanSize(1024), humanSize(1536), humanSize(10 * 1024), humanSize(5 * 1024 * 1024)])
      .toEqual(['0', '1023', '1.0K', '1.5K', '10K', '5.0M']);
    expect(lsDate(NOW - 5 * DAY, NOW)).toBe('Nov 10 09:00');
    expect(lsDate(NOW - 300 * DAY, NOW)).toBe('Jan 19  2026');
    expect(lsDate(NOW + DAY, NOW)).toBe('Nov 16  2026');
  });
});

describe('chmod / chown', () => {
  it('octal and symbolic modes', () => {
    const b = mk();
    const mode = (): string => b.out('ls -l .ssh/id_ed25519').slice(0, 10);
    expect(mode()).toBe('-rw-r--r--');
    b.run('chmod 600 .ssh/id_ed25519'); expect(mode()).toBe('-rw-------');
    b.run('chmod a+r .ssh/id_ed25519'); expect(mode()).toBe('-rw-r--r--');
    b.run('chmod go-rwx .ssh/id_ed25519'); expect(mode()).toBe('-rw-------');
    b.run('chmod u=r,go= .ssh/id_ed25519'); expect(mode()).toBe('-r--------');
    b.run('chmod +x .ssh/id_ed25519'); expect(mode()).toBe('-r-x--x--x');
    b.run('chmod -x .ssh/id_ed25519'); expect(mode()).toBe('-r--------');
    b.run('chmod 4755 run.sh'); expect(b.out('ls -l run.sh').slice(0, 10)).toBe('-rwsr-xr-x');
  });
  it('-R recurses', () => {
    const b = mk();
    b.run('chmod -R go-rwx proj');
    expect(b.out('ls -lR proj').match(/^[-d][rwx-]{9}/gm)).toEqual(['-rw-------', 'drwx------', '-rw-------']);
    expect(b.out('ls -ld proj').slice(0, 10)).toBe('drwx------');
  });
  it.each([
    ['chmod', "chmod: missing operand\nTry 'chmod --help' for more information.\n"],
    ['chmod 600', "chmod: missing operand after '600'\nTry 'chmod --help' for more information.\n"],
    ['chmod 999 notes.txt', "chmod: invalid mode: '999'\nTry 'chmod --help' for more information.\n"],
    ['chmod u+q notes.txt', "chmod: invalid mode: 'u+q'\nTry 'chmod --help' for more information.\n"],
    ['chmod 600 nope', "chmod: cannot access 'nope': No such file or directory\n"],
    ['chmod 600 /etc/app.conf', "chmod: changing permissions of '/etc/app.conf': Operation not permitted\n"],
    ['chown root notes.txt', "chown: changing ownership of 'notes.txt': Operation not permitted\n"],
    ['chown ghost notes.txt', "chown: invalid user: 'ghost'\n"],
    ['chown analyst:ghost notes.txt', "chown: invalid group: 'analyst:ghost'\n"],
    ['chown analyst', "chown: missing operand after 'analyst'\nTry 'chown --help' for more information.\n"],
    ['sudo chown root nope', "chown: cannot access 'nope': No such file or directory\n"],
  ])('%s', (cmd, err) => expect(mk().run(cmd)).toMatchObject({ stderr: err, code: 1 }));
  it('root can chmod and chown anything; owners can switch to their own groups', () => {
    const b = mk();
    b.run('sudo chown root:root notes.txt');
    expect(b.out('ls -l notes.txt')).toMatch(/ root root /);
    b.run('sudo chown analyst: notes.txt; chown :adm notes.txt');
    expect(b.out('ls -l notes.txt')).toMatch(/ analyst adm /);
    b.run('sudo chown -R www-data:www-data proj');
    expect(b.out('ls -l proj').match(/www-data www-data/g)).toHaveLength(2);
    b.run('sudo chmod 600 /etc/app.conf');
    expect(b.run('cat /etc/app.conf').code).toBe(1);
  });
  it('permissions are enforced after a change', () => {
    const b = mk();
    b.run('chmod 000 notes.txt');
    expect(b.run('cat notes.txt').stderr).toBe('cat: notes.txt: Permission denied\n');
    expect(b.run('echo x >> notes.txt').stderr).toBe('bash: notes.txt: Permission denied\n');
    b.run('chmod u+r notes.txt');
    expect(b.out('cat notes.txt')).toBe('hello\nworld\n');
    b.run('chmod u-x proj');
    expect(b.run('cat proj/README').stderr).toBe('cat: proj/README: Permission denied\n');
    expect(b.run('cd proj').stderr).toBe('bash: cd: proj: Permission denied\n');
  });
});

describe('rm / cp / mv / mkdir / touch', () => {
  it('rm', () => {
    const b = mk();
    expect(b.run('rm notes.txt').code).toBe(0);
    expect(b.run('rm notes.txt')).toMatchObject({ stderr: "rm: cannot remove 'notes.txt': No such file or directory\n", code: 1 });
    expect(b.run('rm -f notes.txt').output).toBe('');
    expect(b.run('rm proj').stderr).toBe("rm: cannot remove 'proj': Is a directory\n");
    expect(b.out('rm -rv proj')).toBe("removed 'proj'\n");
    expect(b.run('ls proj').code).toBe(2);
    expect(b.run('rm /etc/app.conf').stderr).toBe("rm: cannot remove '/etc/app.conf': Permission denied\n");
    expect(b.run('sudo rm /etc/app.conf').code).toBe(0);
    expect(b.run('rm').stderr).toMatch(/^rm: missing operand/);
    expect(b.run('sudo rm -rf /').stderr).toMatch(/dangerous to operate recursively on '\/'/);
    expect(b.run('rm -r ..').stderr).toMatch(/refusing to remove/);
    expect(b.run('rm /var/www/upload/shell.php').stderr).toBe("rm: cannot remove '/var/www/upload/shell.php': Permission denied\n");
  });
  it('cp', () => {
    const b = mk();
    b.run('cp notes.txt copy.txt');
    expect(b.out('cat copy.txt')).toBe('hello\nworld\n');
    expect(b.run('cp proj p2').stderr).toBe("cp: -r not specified; omitting directory 'proj'\n");
    b.run('cp -r proj p2');
    expect(b.out('cat p2/src/main.c')).toBe('int main(){}\n');
    b.run('cp notes.txt Zed proj');
    expect(b.out('ls proj')).toBe('README\nZed\nnotes.txt\nsrc\n');
    expect(b.run('cp nope x').stderr).toBe("cp: cannot stat 'nope': No such file or directory\n");
    expect(b.run('cp notes.txt /etc/x').stderr).toBe("cp: cannot create regular file '/etc/x': Permission denied\n");
    expect(b.run('cp /root/secret x').stderr).toBe("cp: cannot stat '/root/secret': Permission denied\n");
    expect(b.run('cp notes.txt notes.txt').stderr).toBe("cp: 'notes.txt' and 'notes.txt' are the same file\n");
    expect(b.run('cp a b c').stderr).toBe("cp: target 'c' is not a directory\n");
    expect(b.run('cp').stderr).toMatch(/^cp: missing file operand/);
    b.run('sudo cp /root/secret /tmp/leak');
    expect(b.out('ls -l /tmp/leak')).toMatch(/^-rw------- 1 root root /);
  });
  it('mv', () => {
    const b = mk();
    b.run('mv notes.txt renamed.txt');
    expect(b.out('cat renamed.txt')).toBe('hello\nworld\n');
    b.run('mv renamed.txt proj/');
    expect(b.out('ls proj')).toBe('README\nrenamed.txt\nsrc\n');
    b.run('mv proj project');
    expect(b.out('ls project/src')).toBe('main.c\n');
    expect(b.run('mv nope x').stderr).toBe("mv: cannot stat 'nope': No such file or directory\n");
    expect(b.run('mv /etc/app.conf .').stderr).toBe("mv: cannot move '/etc/app.conf' to './app.conf': Permission denied\n");
    expect(b.run('mv project project/sub').code).toBe(1);
    b.run('sudo mkdir /root/quarantine; sudo mv /var/www/upload/shell.php /root/quarantine/');
    expect(b.out('sudo ls /root/quarantine')).toBe('shell.php\n');
  });
  it('mkdir and touch', () => {
    const b = mk();
    expect(b.run('mkdir a/b/c').stderr).toBe("mkdir: cannot create directory 'a/b/c': No such file or directory\n");
    b.run('mkdir -p a/b/c; mkdir -p a/b');
    expect(b.out('ls -R a')).toBe('a:\nb\n\na/b:\nc\n\na/b/c:\n');
    expect(b.run('mkdir a').stderr).toBe("mkdir: cannot create directory 'a': File exists\n");
    expect(b.run('mkdir /etc/x').stderr).toBe("mkdir: cannot create directory '/etc/x': Permission denied\n");
    b.run('touch new old.log');
    expect(b.out('ls -l new old.log')).toBe('-rw-r--r-- 1 analyst analyst    0 Nov 15 09:00 new\n-rw-r--r-- 1 analyst analyst 5000 Nov 15 09:00 old.log\n');
    expect(b.run('touch /etc/x').stderr).toBe("touch: cannot touch '/etc/x': Permission denied\n");
    expect(b.run('touch nodir/x').stderr).toBe("touch: cannot touch 'nodir/x': No such file or directory\n");
  });
});

describe('ps / kill / ss', () => {
  it('ps formats', () => {
    const b = mk();
    expect(b.out('ps')).toBe('    PID TTY          TIME CMD\n   2002 pts/0    00:00:00 bash\n   3300 pts/0    00:00:00 sleep\n   4200 pts/0    00:00:00 ps\n');
    const aux = b.out('ps aux').split('\n');
    expect(aux[0]).toBe('USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND');
    expect(aux[1]).toBe('root           1  0.0  0.1 167744 11520 ?        Ss   08:00   0:03 /sbin/init');
    expect(aux.some((l) => /^www-data {4}3127 .* \/tmp\/\.cache\/kworkerd -p 4444$/.test(l))).toBe(true);
    const ef = b.out('ps -ef').split('\n');
    expect(ef[0]).toBe('UID          PID    PPID  C STIME TTY          TIME CMD');
    expect(ef.find((l) => l.includes('worker process'))).toBe('www-data     802     801  0 08:00 ?        00:00:00 nginx: worker process');
    expect(b.out('ps -u postgres')).toBe('    PID TTY          TIME CMD\n    950 ?        00:00:00 postgres\n');
    expect(b.run('ps -p 99999').code).toBe(1);
    expect(b.run('ps -o pid').code).toBe(1);
    expect(b.run('ps -u ghost').code).toBe(1);
  });
  it('the pipeline itself shows up in ps output, as on a real system', () => {
    const lines = mk().out('ps aux | grep kworker').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^analyst .* grep kworker$/);
    expect(mk().out('ps aux | grep kworker | grep -v grep | wc -l')).toBe('1\n');
  });
  it('kill: permissions, signals and errors', () => {
    const b = mk();
    expect(b.run('kill 3127')).toMatchObject({ stderr: 'bash: kill: (3127) - Operation not permitted\n', code: 1 });
    expect(b.run('kill 99999').stderr).toBe('bash: kill: (99999) - No such process\n');
    expect(b.run('kill abc').stderr).toBe('bash: kill: abc: arguments must be process or job IDs\n');
    expect(b.run('kill -FOO 3300').stderr).toBe('bash: kill: FOO: invalid signal specification\n');
    expect(b.run('kill').code).toBe(2);
    expect(b.run('kill -0 3300').code).toBe(0);
    expect(b.state.procs.get(3300)).toBeDefined();
    expect(b.run('kill -STOP 3300; kill -CONT 3300').code).toBe(0);
    expect(b.state.procs.get(3300)).toBeDefined();
    expect(b.run('kill 3300').code).toBe(0);
    expect(b.state.procs.get(3300)).toBeUndefined();
    expect(b.run('sudo kill -9 3127').code).toBe(0);
    expect(b.state.procs.get(3127)).toBeUndefined();
    expect(b.run('cat /proc/3127/cmdline').code).toBe(1);
    for (const form of ['-KILL', '-SIGKILL', '-s KILL', '-15', '-TERM', '-n 9', '-HUP']) {
      const c = mk();
      expect(c.run(`sudo kill ${form} 801`).code).toBe(0);
      expect(c.state.procs.get(801)).toBeUndefined();
    }
    b.run('sudo kill -9 1; kill -9 2002');
    expect([b.state.procs.get(1), b.state.procs.get(2002)].every(Boolean)).toBe(true);
    expect(b.out('kill -l')).toMatch(/ 9\) SIGKILL/);
    expect(b.run('kill 801 3300 99').stderr).toBe('bash: kill: (801) - Operation not permitted\nbash: kill: (3300) - No such process\nbash: kill: (99) - No such process\n');
  });
  it('ss shows listeners; process names need root', () => {
    const b = mk();
    const plain = b.out('ss -tlnp');
    expect(plain.split('\n')[0]).toMatch(/^State +Recv-Q +Send-Q +Local Address:Port +Peer Address:Port +Process$/);
    expect(plain).toMatch(/0\.0\.0\.0:4444/);
    expect(plain).not.toMatch(/kworkerd/);
    const root = b.out('sudo ss -tlnp');
    expect(root).toMatch(/LISTEN +0 +128 +0\.0\.0\.0:4444 +0\.0\.0\.0:\* +users:\(\("kworkerd",pid=3127,fd=3\)\)/);
    expect(root).toMatch(/127\.0\.0\.1:5432 .*"postgres",pid=950/);
    expect(root.trim().split('\n')).toHaveLength(6);
    expect(b.out('ss -tl')).toMatch(/0\.0\.0\.0:ssh/);
    expect(b.out('ss -tln')).not.toMatch(/Process/);
    expect(b.out('ss -uln').trim().split('\n')).toHaveLength(1);
    expect(b.out('ss -tn').trim().split('\n')).toHaveLength(1);
    expect(b.out('ss -ln').split('\n')[0]).toMatch(/^Netid/);
    b.run('sudo kill 3127');
    expect(b.out('sudo ss -tlnp')).not.toMatch(/4444/);
  });
  it('/proc mirrors the process table', () => {
    const b = mk();
    expect(b.out('cat /proc/3127/cmdline')).toBe('/tmp/.cache/kworkerd -p 4444\n');
    expect(b.out('cat /proc/3127/comm')).toBe('kworkerd\n');
    expect(b.out('grep -l kworkerd /proc/*/cmdline')).toBe('/proc/3127/cmdline\n');
    expect(b.out('ls -d /proc/3127 -l')).toMatch(/^dr-xr-xr-x 2 www-data www-data/);
  });
});

describe('find (security-relevant predicates)', () => {
  it('-perm for SUID and world-writable files', () => {
    const b = mk();
    expect(b.out('find /usr -perm -4000 -type f')).toBe('/usr/bin/passwd\n');
    expect(b.out('find /usr/bin -perm 755 -type f')).toBe('/usr/bin/tool\n');
    expect(b.out('find /var/www -perm /o+w -type f')).toBe('/var/www/upload/shell.php\n');
    expect(b.out('find /var/www -perm -o=w -type f')).toBe('/var/www/upload/shell.php\n');
    expect(b.out('find /var/www -perm /022 -type f')).toBe('/var/www/upload/shell.php\n');
    expect(b.run('find / -perm zz').stderr).toBe("find: invalid mode 'zz'\n");
  });
  it('-user, -group, -mtime, -mmin, -newer', () => {
    const b = mk();
    expect(b.out('find /var -user www-data')).toBe('/var/www/upload/shell.php\n');
    expect(b.out('find /var -user 33')).toBe('/var/www/upload/shell.php\n');
    expect(b.out('find /home/analyst -maxdepth 1 -group analyst -name "*.log"')).toBe('/home/analyst/old.log\n');
    expect(b.out('find /home/analyst -mtime +365')).toBe('/home/analyst/old.log\n');
    expect(b.out('find /etc /var/www -type f -mtime -1')).toBe('/etc/app.conf\n/var/www/upload/shell.php\n');
    expect(b.out('find /etc /var/www -type f -mmin -30')).toBe('/var/www/upload/shell.php\n');
    expect(b.out('find /var/www -type f -newer /etc/app.conf')).toBe('/var/www/upload/shell.php\n');
    expect(b.run('find / -user ghost').stderr).toBe("find: 'ghost' is not the name of a known user\n");
    expect(b.run('find / -newer /nope').code).toBe(1);
  });
  it('reports unreadable directories and keeps going', () => {
    const r = mk().run('find / -name secret');
    expect(r.stderr).toBe("find: '/root': Permission denied\nfind: '/srv/locked': Permission denied\n");
    expect(r.code).toBe(1);
    expect(mk().out('sudo find / -name secret')).toBe('/root/secret\n');
    expect(mk().run('find / -name secret 2>/dev/null').output).toBe('');
  });
  it('default path, -delete, -exec, operand ordering', () => {
    const b = mk();
    expect(b.out('find -name "*.c"')).toBe('./proj/src/main.c\n');
    expect(b.out('find proj -type f -exec grep -l password {} \\;')).toBe('proj/README\n');
    expect(b.out('find proj -name "*.c" -exec cat {} \\;')).toBe('int main(){}\n');
    b.run('find proj -delete');
    expect(b.run('ls proj').code).toBe(2);
    expect(b.run('find -name x y').stderr).toBe("find: paths must precede expression: 'y'\n");
    expect(b.run('find . -type z').code).toBe(1);
  });
});

describe('grep on directories', () => {
  it('-r searches recursively and prefixes file names', () => {
    const b = mk();
    expect(b.out('grep -r password proj')).toBe('proj/README:TODO: password=hunter2\n');
    expect(b.out('grep -rn main proj/')).toBe('proj/src/main.c:1:int main(){}\n');
    expect(b.out('grep -rl hello .')).toBe('./notes.txt\n');
    expect(b.out('grep -rh hello .')).toBe('hello\n');
    b.run('cd proj');
    expect(b.out('grep -r main')).toBe('src/main.c:int main(){}\n');
    expect(b.out('grep -rc main . | sort')).toBe('./README:0\n./src/main.c:1\n');
  });
  it('permission errors go to stderr with exit status 2', () => {
    const r = mk().run('grep -r top /root /srv');
    expect(r.stderr).toBe('grep: /root: Permission denied\ngrep: /srv/locked: Permission denied\n');
    expect(r.code).toBe(2);
    expect(mk().out('sudo grep -r top /root')).toBe('/root/secret:top\n');
  });
  it('-P accepts Perl-style classes', () => {
    expect(mk().out('grep -oP "\\d+" proj/README')).toBe('2\n');
  });
});

describe('sha256sum -c details', () => {
  it('flags missing files and malformed manifests', () => {
    const b = mk();
    b.run('sha256sum notes.txt Zed > sums; rm Zed; echo garbage >> sums');
    const r = b.run('sha256sum -c sums');
    expect(r.stdout).toBe('notes.txt: OK\nZed: FAILED open or read\n');
    expect(r.stderr).toBe('sha256sum: Zed: No such file or directory\nsha256sum: WARNING: 1 line is improperly formatted\nsha256sum: WARNING: 1 listed file could not be read\n');
    expect(r.code).toBe(1);
    expect(b.run('sha256sum -c notes.txt').stderr).toBe('sha256sum: notes.txt: no properly formatted checksum lines found\n');
    expect(b.out('sha256sum notes.txt | sha256sum -c')).toBe('notes.txt: OK\n');
    expect(b.out('sha256sum -c sums 2>/dev/null | grep -v OK')).toBe('Zed: FAILED open or read\n');
  });
  it('plural warnings', () => {
    const b = mk();
    b.run('sha256sum notes.txt run.sh > sums; echo x >> notes.txt; echo y >> run.sh');
    expect(b.run('sha256sum -c sums').stderr).toBe('sha256sum: WARNING: 2 computed checksums did NOT match\n');
  });
});

describe('misc', () => {
  it('date, hostname, clear, true/false', () => {
    const b = mk();
    expect(b.out('date')).toBe('Sun Nov 15 09:00:00 UTC 2026\n');
    expect(b.out('hostname')).toBe('web01\n');
    expect(b.out('clear')).toBe('');
    expect(b.sh.run('clear', { tty: true }).output).toBe('\x1b[H\x1b[2J\x1b[3J');
    expect([b.run('true').code, b.run('false').code]).toEqual([0, 1]);
    expect(b.run('tail -f notes.txt').stderr).toMatch(/not supported/);
  });
});
