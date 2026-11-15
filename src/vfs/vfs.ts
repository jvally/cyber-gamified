// Virtual filesystem: an in-memory tree with Unix-style modes, owners and mtimes.
// Nothing here touches the real OS.

export type ErrCode =
  | 'ENOENT' | 'EACCES' | 'ENOTDIR' | 'EISDIR' | 'EEXIST' | 'ENOTEMPTY' | 'EPERM' | 'EINVAL';

export const ERR_MSG: Record<ErrCode, string> = {
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EEXIST: 'File exists',
  ENOTEMPTY: 'Directory not empty',
  EPERM: 'Operation not permitted',
  EINVAL: 'Invalid argument',
};

export class FsError extends Error {
  constructor(public code: ErrCode, public path: string) {
    super(ERR_MSG[code]);
  }
}

export interface Cred { user: string; groups: string[] }
export const ROOT: Cred = { user: 'root', groups: ['root'] };

interface Meta { mode: number; owner: string; group: string; mtime: number }
export interface FileNode extends Meta { type: 'file'; content: string }
export interface DirNode extends Meta { type: 'dir'; children: Map<string, VNode> }
export type VNode = FileNode | DirNode;

const encoder = new TextEncoder();
export const byteLength = (s: string): number => encoder.encode(s).length;
export const nodeSize = (n: VNode): number => (n.type === 'dir' ? 4096 : byteLength(n.content));

/** Byte-order (LC_ALL=C) string comparison. */
export const cmpC = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const R = 4, W = 2, X = 1;

export function normalize(path: string, cwd = '/'): string {
  const full = path.startsWith('/') ? path : `${cwd}/${path}`;
  const out: string[] = [];
  for (const seg of full.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}
export const dirname = (abs: string): string => {
  const i = abs.lastIndexOf('/');
  return i <= 0 ? '/' : abs.slice(0, i);
};
export const basename = (p: string): string => {
  const t = p.replace(/\/+$/, '');
  return t === '' ? '/' : t.slice(t.lastIndexOf('/') + 1);
};

export function can(node: VNode, cred: Cred, bit: number): boolean {
  if (cred.user === 'root') return true;
  if (node.owner === cred.user) return ((node.mode >> 6) & bit) !== 0;
  if (cred.groups.includes(node.group)) return ((node.mode >> 3) & bit) !== 0;
  return (node.mode & bit) !== 0;
}

export interface PutOpts { mode?: number; owner?: string; group?: string; mtime?: number }

export class VFS {
  root: DirNode;
  constructor(public now: number) {
    this.root = { type: 'dir', mode: 0o755, owner: 'root', group: 'root', mtime: now, children: new Map() };
  }

  /** Walk to a node. With `cred`, every directory on the way needs search (x) permission. */
  get(abs: string, cred?: Cred): VNode {
    let node: VNode = this.root;
    for (const seg of abs.split('/')) {
      if (seg === '') continue;
      if (node.type !== 'dir') throw new FsError('ENOTDIR', abs);
      if (cred && !can(node, cred, X)) throw new FsError('EACCES', abs);
      const next = node.children.get(seg);
      if (!next) throw new FsError('ENOENT', abs);
      node = next;
    }
    return node;
  }
  tryGet(abs: string, cred?: Cred): VNode | undefined {
    try { return this.get(abs, cred); } catch { return undefined; }
  }
  exists(abs: string): boolean { return this.tryGet(abs) !== undefined; }
  isDir(abs: string): boolean { return this.tryGet(abs)?.type === 'dir'; }

  private parent(abs: string, cred?: Cred): { dir: DirNode; name: string } {
    if (abs === '/') throw new FsError('EPERM', abs);
    let dir: VNode;
    try { dir = this.get(dirname(abs), cred); } catch (e) { throw new FsError((e as FsError).code, abs); }
    if (dir.type !== 'dir') throw new FsError('ENOTDIR', abs);
    if (cred && !can(dir, cred, X)) throw new FsError('EACCES', abs);
    return { dir, name: basename(abs) };
  }

  readFile(abs: string, cred?: Cred): string {
    const n = this.get(abs, cred);
    if (n.type === 'dir') throw new FsError('EISDIR', abs);
    if (cred && !can(n, cred, R)) throw new FsError('EACCES', abs);
    return n.content;
  }

  writeFile(abs: string, content: string, cred?: Cred, append = false, mode = 0o644): void {
    const { dir, name } = this.parent(abs, cred);
    const existing = dir.children.get(name);
    if (existing) {
      if (existing.type === 'dir') throw new FsError('EISDIR', abs);
      if (cred && !can(existing, cred, W)) throw new FsError('EACCES', abs);
      existing.content = append ? existing.content + content : content;
      existing.mtime = this.now;
      return;
    }
    if (cred && !can(dir, cred, W)) throw new FsError('EACCES', abs);
    dir.children.set(name, {
      type: 'file', content, mode, mtime: this.now,
      owner: cred?.user ?? 'root', group: cred?.groups[0] ?? 'root',
    });
    dir.mtime = this.now;
  }

  list(abs: string, cred?: Cred): string[] {
    const n = this.get(abs, cred);
    if (n.type !== 'dir') throw new FsError('ENOTDIR', abs);
    if (cred && !can(n, cred, R)) throw new FsError('EACCES', abs);
    return [...n.children.keys()].sort(cmpC);
  }

  mkdir(abs: string, cred?: Cred, mode = 0o755): void {
    const { dir, name } = this.parent(abs, cred);
    if (dir.children.has(name)) throw new FsError('EEXIST', abs);
    if (cred && !can(dir, cred, W)) throw new FsError('EACCES', abs);
    dir.children.set(name, {
      type: 'dir', mode, mtime: this.now, children: new Map(),
      owner: cred?.user ?? 'root', group: cred?.groups[0] ?? 'root',
    });
    dir.mtime = this.now;
  }

  /** Unlink a file or remove an empty directory. Honours the sticky bit. */
  remove(abs: string, cred?: Cred): void {
    const { dir, name } = this.parent(abs, cred);
    const n = dir.children.get(name);
    if (!n) throw new FsError('ENOENT', abs);
    if (cred && !can(dir, cred, W)) throw new FsError('EACCES', abs);
    if (cred && cred.user !== 'root' && dir.mode & 0o1000 && n.owner !== cred.user && dir.owner !== cred.user) {
      throw new FsError('EPERM', abs);
    }
    if (n.type === 'dir' && n.children.size > 0) throw new FsError('ENOTEMPTY', abs);
    dir.children.delete(name);
    dir.mtime = this.now;
  }

  rename(src: string, dst: string, cred?: Cred): void {
    const from = this.parent(src, cred);
    const n = from.dir.children.get(from.name);
    if (!n) throw new FsError('ENOENT', src);
    if (dst === src) return;
    if (n.type === 'dir' && (dst + '/').startsWith(src + '/')) throw new FsError('EINVAL', dst);
    const to = this.parent(dst, cred);
    if (cred && !can(from.dir, cred, W)) throw new FsError('EACCES', src);
    if (cred && cred.user !== 'root' && from.dir.mode & 0o1000 && n.owner !== cred.user && from.dir.owner !== cred.user) {
      throw new FsError('EPERM', src);
    }
    if (cred && !can(to.dir, cred, W)) throw new FsError('EACCES', dst);
    const target = to.dir.children.get(to.name);
    if (target?.type === 'dir' && (n.type !== 'dir' || target.children.size > 0)) {
      throw new FsError(n.type === 'dir' ? 'ENOTEMPTY' : 'EISDIR', dst);
    }
    if (target && target.type === 'file' && n.type === 'dir') throw new FsError('ENOTDIR', dst);
    from.dir.children.delete(from.name);
    to.dir.children.set(to.name, n);
    from.dir.mtime = to.dir.mtime = this.now;
  }

  chmod(abs: string, mode: number, cred?: Cred): void {
    const n = this.get(abs, cred);
    if (cred && cred.user !== 'root' && n.owner !== cred.user) throw new FsError('EPERM', abs);
    n.mode = mode & 0o7777;
  }

  chown(abs: string, owner: string | undefined, group: string | undefined, cred?: Cred): void {
    const n = this.get(abs, cred);
    if (cred && cred.user !== 'root') {
      const ownerChange = owner !== undefined && owner !== n.owner;
      const groupOk = group === undefined || (n.owner === cred.user && cred.groups.includes(group));
      if (ownerChange || !groupOk) throw new FsError('EPERM', abs);
    }
    if (owner !== undefined) n.owner = owner;
    if (group !== undefined) n.group = group;
  }

  // ---- setup helpers (no permission checks; parents auto-created as root 755) ----
  putDir(abs: string, o: PutOpts = {}): DirNode {
    let node: DirNode = this.root;
    const segs = abs.split('/').filter(Boolean);
    segs.forEach((seg, i) => {
      let next = node.children.get(seg);
      if (!next) {
        next = { type: 'dir', mode: 0o755, owner: 'root', group: 'root', mtime: o.mtime ?? this.now, children: new Map() };
        node.children.set(seg, next);
      }
      if (next.type !== 'dir') throw new FsError('ENOTDIR', abs);
      if (i === segs.length - 1) {
        if (o.mode !== undefined) next.mode = o.mode;
        if (o.owner !== undefined) next.owner = next.group = o.owner;
        if (o.group !== undefined) next.group = o.group;
        if (o.mtime !== undefined) next.mtime = o.mtime;
      }
      node = next;
    });
    return node;
  }
  putFile(abs: string, content: string, o: PutOpts = {}): void {
    const dir = this.putDir(dirname(abs));
    dir.children.set(basename(abs), {
      type: 'file', content, mode: o.mode ?? 0o644, owner: o.owner ?? 'root',
      group: o.group ?? o.owner ?? 'root', mtime: o.mtime ?? this.now,
    });
  }
}
