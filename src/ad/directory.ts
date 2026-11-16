// A small simulated Active Directory domain: users, groups, computers, OUs and GPOs.
// It models only what the levels need; nothing here talks to a real directory.

export const DOMAIN = 'corp.example';
export const DOMAIN_DN = 'DC=corp,DC=example';
export const DAY = 86400;

export interface AdUser {
  kind: 'user'; sam: string; given: string; surname: string; parent: string;
  enabled: boolean; lockedOut: boolean; mustChange: boolean; pwdNeverExpires: boolean;
  pwdLastSet: number; lastLogon: number | null; created: number;
  title: string; department: string; description: string;
  /** how many times the password was reset during this session */
  pwdResets: number;
}
export interface AdGroup { kind: 'group'; name: string; parent: string; members: string[]; scope: 'Global' | 'DomainLocal' | 'Universal'; description: string }
export interface AdComputer { kind: 'computer'; name: string; parent: string; os: string; enabled: boolean; lastLogon: number | null }
export interface GpLink { gpo: string; enabled: boolean; enforced: boolean }
export interface AdOU { kind: 'ou'; name: string; parent: string; /** built-in container (CN=...) rather than a real OU */ container: boolean; links: GpLink[]; description: string }
export interface Gpo { name: string; id: string; description: string; settings: string[]; created: number; modified: number }
export interface PasswordPolicy { minLength: number; lockoutThreshold: number; complexity: boolean; maxAgeDays: number; historyCount: number }
export type AdObject = AdUser | AdGroup | AdComputer | AdOU;

export const normDn = (dn: string): string => dn.split(',').map((p) => p.trim()).join(',').toLowerCase();
export const sameDn = (a: string, b: string): boolean => normDn(a) === normDn(b);
export const userName = (u: AdUser): string => (u.surname ? `${u.given} ${u.surname}` : u.given);

export class Directory {
  users: AdUser[] = [];
  groups: AdGroup[] = [];
  computers: AdComputer[] = [];
  ous: AdOU[] = [];
  gpos: Gpo[] = [];
  /** GPO links on the domain root itself */
  domainLinks: GpLink[] = [];
  policy: PasswordPolicy = { minLength: 12, lockoutThreshold: 5, complexity: true, maxAgeDays: 90, historyCount: 24 };
  private guid = 0;
  constructor(public now: number) {}

  // ---- construction helpers -------------------------------------------------
  ou(name: string, parent = DOMAIN_DN, o: Partial<AdOU> = {}): this {
    this.ous.push({ kind: 'ou', name, parent, container: false, links: [], description: '', ...o });
    return this;
  }
  user(sam: string, given: string, surname: string, parent: string, o: Partial<AdUser> = {}): this {
    this.users.push({
      kind: 'user', sam, given, surname, parent, enabled: true, lockedOut: false, mustChange: false, pwdNeverExpires: false,
      pwdLastSet: this.now - 30 * DAY, lastLogon: this.now - DAY, created: this.now - 700 * DAY,
      title: '', department: '', description: '', pwdResets: 0, ...o,
    });
    return this;
  }
  group(name: string, parent: string, members: string[], o: Partial<AdGroup> = {}): this {
    this.groups.push({ kind: 'group', name, parent, members: [...members], scope: 'Global', description: '', ...o });
    return this;
  }
  computer(name: string, parent: string, os: string, o: Partial<AdComputer> = {}): this {
    this.computers.push({ kind: 'computer', name, parent, os, enabled: true, lastLogon: this.now - 3600, ...o });
    return this;
  }
  gpo(name: string, description: string, settings: string[]): this {
    const n = (++this.guid).toString(16).padStart(4, '0');
    this.gpos.push({ name, id: `31b2f340-016d-11d2-945f-00c04fb9${n}`, description, settings, created: this.now - 400 * DAY, modified: this.now - 60 * DAY });
    return this;
  }
  link(target: string, gpo: string, enforced = false): this {
    this.linksOf(target)!.push({ gpo, enabled: true, enforced });
    return this;
  }

  // ---- lookups --------------------------------------------------------------
  dn(o: AdObject): string {
    if (o.kind === 'user') return `CN=${userName(o)},${o.parent}`;
    if (o.kind === 'ou') return `${o.container ? 'CN' : 'OU'}=${o.name},${o.parent}`;
    return `CN=${o.name},${o.parent}`;
  }
  all(): AdObject[] { return [...this.ous, ...this.users, ...this.groups, ...this.computers]; }
  byDn(dn: string): AdObject | undefined { return this.all().find((o) => sameDn(this.dn(o), dn)); }
  findUser(id: string): AdUser | undefined {
    const k = id.toLowerCase();
    return this.users.find((u) => u.sam.toLowerCase() === k || sameDn(this.dn(u), id));
  }
  findGroup(id: string): AdGroup | undefined {
    const k = id.toLowerCase();
    return this.groups.find((g) => g.name.toLowerCase() === k || sameDn(this.dn(g), id));
  }
  findComputer(id: string): AdComputer | undefined {
    const k = id.toLowerCase().replace(/\$$/, '');
    return this.computers.find((c) => c.name.toLowerCase() === k || sameDn(this.dn(c), id));
  }
  findOU(dn: string): AdOU | undefined { return this.ous.find((o) => sameDn(this.dn(o), dn)); }
  findGpo(name: string): Gpo | undefined { return this.gpos.find((g) => g.name.toLowerCase() === name.toLowerCase()); }
  /** Is `dn` a place objects can live in (domain root, OU or container)? */
  isContainer(dn: string): boolean { return sameDn(dn, DOMAIN_DN) || !!this.findOU(dn); }
  /** GPO link list for a domain root or a real OU; undefined for anything else. */
  linksOf(dn: string): GpLink[] | undefined {
    if (sameDn(dn, DOMAIN_DN)) return this.domainLinks;
    const ou = this.findOU(dn);
    return ou && !ou.container ? ou.links : undefined;
  }
  groupsOf(member: string): AdGroup[] {
    return this.groups.filter((g) => g.members.some((m) => m.toLowerCase() === member.toLowerCase()));
  }
  /** Is the object at or below `base`? */
  under(o: AdObject, base: string): boolean { return (',' + normDn(this.dn(o))).endsWith(',' + normDn(base)); }
  /** Does a password satisfy the domain policy? */
  passwordOk(pw: string): boolean {
    if (pw.length < this.policy.minLength) return false;
    if (!this.policy.complexity) return true;
    return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length >= 3;
  }
}

/** The corp.example baseline every AD level starts from. */
export function baseDirectory(now: number): Directory {
  const d = new Directory(now);
  const ou = (n: string): string => `OU=${n},${DOMAIN_DN}`;
  d.ous.push({ kind: 'ou', name: 'Users', parent: DOMAIN_DN, container: true, links: [], description: 'Default container for upgraded user accounts' });
  d.ous.push({ kind: 'ou', name: 'Computers', parent: DOMAIN_DN, container: true, links: [], description: 'Default container for upgraded computer accounts' });
  d.ou('Domain Controllers').ou('Servers').ou('IT').ou('Finance').ou('Engineering').ou('Sales').ou('Service Accounts');
  const users = `CN=Users,${DOMAIN_DN}`;
  d.user('Administrator', 'Administrator', '', users, { description: 'Built-in account for administering the domain', created: now - 1500 * DAY, lastLogon: now - 40 * DAY })
    .user('adm.kchen', 'Kim', 'Chen (Admin)', ou('IT'), { title: 'Systems Administrator', department: 'IT', description: 'Privileged account' })
    .user('kchen', 'Kim', 'Chen', ou('IT'), { title: 'Systems Administrator', department: 'IT' })
    .user('omartin', 'Omar', 'Martin', ou('IT'), { title: 'Helpdesk Technician', department: 'IT' })
    .user('mlopez', 'Maria', 'Lopez', ou('Finance'), { title: 'Accountant', department: 'Finance' })
    .user('dnguyen', 'David', 'Nguyen', ou('Finance'), { title: 'Finance Manager', department: 'Finance' })
    .user('asmith', 'Alex', 'Smith', ou('Engineering'), { title: 'Software Engineer', department: 'Engineering' })
    .user('bwong', 'Bea', 'Wong', ou('Engineering'), { title: 'QA Engineer', department: 'Engineering' })
    .user('tjones', 'Tom', 'Jones', ou('Sales'), { title: 'Sales Intern', department: 'Sales', created: now - 60 * DAY })
    .user('lfischer', 'Lena', 'Fischer', ou('Sales'), { title: 'Account Executive', department: 'Sales' })
    .user('rpatel', 'Raj', 'Patel', ou('Sales'), { title: 'Sales Manager', department: 'Sales', lastLogon: now - 150 * DAY })
    .user('jdoe', 'John', 'Doe', ou('Sales'), { title: 'Account Executive', department: 'Sales', enabled: false, lastLogon: now - 300 * DAY, description: 'Left 2026-01' })
    .user('svc_backup', 'svc_backup', '', ou('Service Accounts'), { pwdNeverExpires: true, description: 'Backup agent service account', lastLogon: now - 7200 });
  d.group('Domain Admins', users, ['Administrator', 'adm.kchen'], { description: 'Designated administrators of the domain' })
    .group('Domain Users', users, d.users.map((u) => u.sam), { description: 'All domain users' })
    .group('Helpdesk', ou('IT'), ['omartin', 'kchen'], { description: 'Password resets and account unlocks' })
    .group('Finance-Staff', ou('Finance'), ['mlopez', 'dnguyen'])
    .group('Sales-Staff', ou('Sales'), ['tjones', 'lfischer']);
  d.computer('SRV-DC01', ou('Domain Controllers'), 'Windows Server 2022 Standard')
    .computer('SRV-FILE01', ou('Servers'), 'Windows Server 2022 Standard')
    .computer('WS-001', `CN=Computers,${DOMAIN_DN}`, 'Windows 11 Enterprise')
    .computer('WS-002', `CN=Computers,${DOMAIN_DN}`, 'Windows 11 Enterprise')
    .computer('WS-003', `CN=Computers,${DOMAIN_DN}`, 'Windows 11 Enterprise');
  d.gpo('Default Domain Policy', 'Domain-wide password and account lockout policy', ['Minimum password length: 12', 'Account lockout threshold: 5 attempts'])
    .gpo('Default Domain Controllers Policy', 'Security settings for domain controllers', ['Audit logon events: Success, Failure'])
    .gpo('Workstation Baseline', 'Security baseline for end-user workstations', ['Screen lock after 10 minutes idle', 'Removable storage: deny write access', 'Windows Firewall: on for all profiles'])
    .gpo('Legacy Kiosk Mode', 'Old lobby kiosk lockdown. Do not link to staff machines.', ['Shell replaced with kiosk browser', 'Auto-logon as kiosk user']);
  d.link(DOMAIN_DN, 'Default Domain Policy').link(ou('Domain Controllers'), 'Default Domain Controllers Policy');
  return d;
}
