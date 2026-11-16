import { describe, expect, it } from 'vitest';
import { can, FsError, normalize, R, VFS, W, X, basename, dirname } from '../src/vfs/vfs';
import { applyMode, modeString } from '../src/vfs/perms';
import { sha256 } from '../src/crypto/sha256';
import { b64decode, b64encode } from '../src/crypto/base64';

const alice = { user: 'alice', groups: ['alice', 'staff'] };
const bob = { user: 'bob', groups: ['bob'] };
const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as FsError).code; }
  return 'OK';
};

describe('path helpers', () => {
  it.each([
    ['a/b', '/x', '/x/a/b'], ['/a//b/', '/x', '/a/b'], ['..', '/x/y', '/x'], ['../../..', '/x', '/'],
    ['./a/./b/../c', '/', '/a/c'], ['', '/x', '/x'], ['/', '/x', '/'],
  ])('normalize(%s, %s) = %s', (p, cwd, want) => expect(normalize(p, cwd)).toBe(want));
  it('basename / dirname', () => {
    expect([basename('/a/b'), basename('/a/b/'), basename('/'), dirname('/a/b'), dirname('/a'), dirname('/')])
      .toEqual(['b', 'b', '/', '/a', '/', '/']);
  });
});

describe('VFS', () => {
  const mk = (): VFS => {
    const v = new VFS(1000);
    v.putDir('/home/alice', { owner: 'alice', mode: 0o750 });
    v.putFile('/home/alice/note', 'hi', { owner: 'alice', mode: 0o640 });
    v.putFile('/home/alice/pub', 'x', { owner: 'alice', group: 'staff', mode: 0o604 });
    v.putDir('/tmp', { mode: 0o1777 });
    v.putFile('/tmp/alice.tmp', 'a', { owner: 'alice' });
    v.putFile('/etc/conf', 'c', { mode: 0o644 });
    return v;
  };
  it('auto-creates parents as root 755', () => {
    const n = mk().get('/home');
    expect([n.owner, n.mode, n.type]).toEqual(['root', 0o755, 'dir']);
  });
  it('reads with owner / group / other bits', () => {
    const v = mk();
    expect(v.readFile('/home/alice/note', alice)).toBe('hi');
    expect(code(() => v.readFile('/home/alice/note', bob))).toBe('EACCES'); // no x on /home/alice
    expect(code(() => v.readFile('/etc/conf', bob))).toBe('OK');
    expect(code(() => v.readFile('/etc/missing', bob))).toBe('ENOENT');
    expect(code(() => v.readFile('/etc', bob))).toBe('EISDIR');
    expect(code(() => v.readFile('/etc/conf/x', bob))).toBe('ENOTDIR');
  });
  it('group class is used even when "other" is more permissive', () => {
    const v = mk();
    // pub is 604 group staff: alice is owner (rw), a staff member would get ---, others r--
    expect(can(v.get('/home/alice/pub'), { user: 'carol', groups: ['staff'] }, R)).toBe(false);
    expect(can(v.get('/home/alice/pub'), bob, R)).toBe(true);
  });
  it('root bypasses permission bits', () => {
    const v = mk();
    expect(v.readFile('/home/alice/note', { user: 'root', groups: ['root'] })).toBe('hi');
    expect(can(v.get('/home/alice/note'), { user: 'root', groups: [] }, W | X)).toBe(true);
  });
  it('writes: create needs w on dir, overwrite needs w on file', () => {
    const v = mk();
    expect(code(() => v.writeFile('/etc/new', 'x', bob))).toBe('EACCES');
    expect(code(() => v.writeFile('/etc/conf', 'x', bob))).toBe('EACCES');
    v.writeFile('/tmp/b', 'one', bob);
    v.writeFile('/tmp/b', 'two', bob, true);
    expect(v.readFile('/tmp/b')).toBe('onetwo');
    expect([v.get('/tmp/b').owner, v.get('/tmp/b').mtime]).toEqual(['bob', 1000]);
    expect(code(() => v.writeFile('/nodir/f', 'x', bob))).toBe('ENOENT');
    expect(code(() => v.writeFile('/tmp', 'x', bob))).toBe('EISDIR');
  });
  it('sticky bit: only the owner may delete in /tmp', () => {
    const v = mk();
    expect(code(() => v.remove('/tmp/alice.tmp', bob))).toBe('EPERM');
    expect(code(() => v.remove('/tmp/alice.tmp', alice))).toBe('OK');
    expect(v.exists('/tmp/alice.tmp')).toBe(false);
  });
  it('remove / mkdir / list / rename', () => {
    const v = mk();
    expect(code(() => v.remove('/home', alice))).toBe('EACCES');
    expect(code(() => v.remove('/home'))).toBe('ENOTEMPTY');
    expect(code(() => v.mkdir('/tmp', alice))).toBe('EEXIST');
    v.mkdir('/tmp/d', alice);
    expect(v.list('/tmp')).toEqual(['alice.tmp', 'd']);
    expect(code(() => v.list('/home/alice', bob))).toBe('EACCES');
    expect(code(() => v.list('/etc/conf'))).toBe('ENOTDIR');
    v.rename('/tmp/alice.tmp', '/tmp/d/moved', alice);
    expect(v.readFile('/tmp/d/moved')).toBe('a');
    expect(code(() => v.rename('/tmp/d', '/tmp/d/sub', alice))).toBe('EINVAL');
    expect(code(() => v.rename('/etc/conf', '/tmp/conf', alice))).toBe('EACCES');
    expect(code(() => v.rename('/tmp/nope', '/tmp/x', alice))).toBe('ENOENT');
  });
  it('chmod / chown ownership rules', () => {
    const v = mk();
    expect(code(() => v.chmod('/etc/conf', 0o600, alice))).toBe('EPERM');
    v.chmod('/tmp/alice.tmp', 0o4755, alice);
    expect(v.get('/tmp/alice.tmp').mode).toBe(0o4755);
    expect(code(() => v.chown('/tmp/alice.tmp', 'bob', undefined, alice))).toBe('EPERM');
    expect(code(() => v.chown('/tmp/alice.tmp', undefined, 'staff', alice))).toBe('OK');
    expect(code(() => v.chown('/tmp/alice.tmp', undefined, 'bob', alice))).toBe('EPERM');
    v.chown('/tmp/alice.tmp', 'bob', 'bob', { user: 'root', groups: [] });
    expect(v.get('/tmp/alice.tmp').owner).toBe('bob');
  });
});

describe('mode parsing and formatting', () => {
  it.each([
    [0o644, false, '-rw-r--r--'], [0o755, true, 'drwxr-xr-x'], [0o1777, true, 'drwxrwxrwt'], [0o4755, false, '-rwsr-xr-x'],
    [0o2644, false, '-rw-r-Sr--'], [0o1000, true, 'd--------T'], [0, false, '----------'],
  ])('modeString(%o) = %s', (m, d, want) => expect(modeString(m, d)).toBe(want));

  it.each<[string, number, number | null]>([
    ['600', 0o644, 0o600], ['0755', 0, 0o755], ['4755', 0, 0o4755], ['u+x', 0o644, 0o744], ['go-rwx', 0o777, 0o700],
    ['u=rw,go=', 0o777, 0o600], ['a+x', 0o644, 0o755], ['+x', 0o644, 0o755], ['+w', 0o444, 0o644], ['o+w', 0o644, 0o646],
    ['a-w', 0o666, 0o444], ['g=u', 0o640, 0o660], ['u+s', 0o755, 0o4755], ['+t', 0o777, 0o1777], ['ug+rw,o-rwx', 0o007, 0o660],
    ['=r', 0o777, 0o444], ['u+r-w', 0o200, 0o400], ['X', 0o644, null], ['rwx', 0o644, null], ['888', 0, null], ['u+z', 0, null],
    ['', 0o644, null], ['a+X', 0o644, 0o644], ['a+X', 0o744, 0o755],
  ])('applyMode(%s, %o) = %o', (spec, old, want) => expect(applyMode(spec, old, false)).toBe(want));
  it('X applies to directories', () => expect(applyMode('a+X', 0o600, true)).toBe(0o711));
});

describe('crypto', () => {
  it('sha256 matches NIST vectors', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(sha256('a'.repeat(1000000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });
  it('sha256 handles block-boundary lengths', () => {
    const seen = new Set([55, 56, 57, 63, 64, 65, 119, 120].map((n) => sha256('x'.repeat(n))));
    expect(seen.size).toBe(8);
    expect(sha256('x'.repeat(64))).toBe('7ce100971f64e7001e8fe5a51973ecdfe1ced42befe7ee8d5fd6219506b5393c');
  });
  it('base64 round-trips, including multi-byte characters', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'hello world\n', 'héllo ✓', 'x'.repeat(100)]) {
      expect(b64decode(b64encode(s))).toEqual({ text: s, ok: true });
    }
    expect(b64encode('hello')).toBe('aGVsbG8=');
    expect(b64decode('aGVsbG8').ok).toBe(false);
    expect(b64decode('aGV$bG8=').ok).toBe(false);
  });
});
