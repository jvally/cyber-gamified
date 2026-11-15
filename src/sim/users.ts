import type { Cred } from '../vfs/vfs';

export interface User { name: string; uid: number; gid: number; home: string; shell: string; groups: string[] }

export class UserDb {
  users: User[] = [];
  groups = new Map<string, number>();
  add(name: string, uid: number, home: string, extraGroups: string[] = [], shell = '/usr/sbin/nologin'): this {
    this.users.push({ name, uid, gid: uid, home, shell, groups: [name, ...extraGroups] });
    this.groups.set(name, uid);
    return this;
  }
  addGroup(name: string, gid: number): this { this.groups.set(name, gid); return this; }
  get(name: string): User | undefined { return this.users.find((u) => u.name === name); }
  byUid(uid: number): User | undefined { return this.users.find((u) => u.uid === uid); }
  hasGroup(name: string): boolean { return this.groups.has(name); }
  cred(name: string): Cred { return { user: name, groups: this.get(name)?.groups ?? [name] }; }
  passwd(): string {
    return this.users.map((u) => `${u.name}:x:${u.uid}:${u.gid}:${u.name}:${u.home}:${u.shell}`).join('\n') + '\n';
  }
  groupFile(): string {
    return [...this.groups].map(([g, gid]) =>
      `${g}:x:${gid}:${this.users.filter((u) => u.groups.includes(g) && u.name !== g).map((u) => u.name).join(',')}`,
    ).join('\n') + '\n';
  }
}

export function defaultUsers(): UserDb {
  return new UserDb()
    .addGroup('sudo', 27).addGroup('adm', 4)
    .add('root', 0, '/root', [], '/bin/bash')
    .add('daemon', 1, '/usr/sbin')
    .add('www-data', 33, '/var/www')
    .add('syslog', 104, '/home/syslog')
    .add('postgres', 113, '/var/lib/postgresql', [], '/bin/bash')
    .add('analyst', 1000, '/home/analyst', ['sudo', 'adm'], '/bin/bash');
}
