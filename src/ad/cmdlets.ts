// Cmdlets for the simulated Active Directory console. Output mimics the real RSAT cmdlets where practical.
import { AdComputer, AdGroup, AdObject, AdOU, AdUser, DAY, Directory, DOMAIN, DOMAIN_DN, Gpo, sameDn, userName } from './directory';
import {
  Bound, CmdletSpec, compileFilter, formatList, formatTable, Item, propOf, PsDate, PsError, PsObject, PsValue,
  SecureString, sortValues, Tok,
} from './powershell';
import type { AdState } from './types';
import type { GameHooks } from '../shell/state';

type Ref = AdObject | { kind: 'gpo'; gpo: Gpo };
export interface Ctx { dir: Directory; state: AdState; p: Bound; args: Tok[]; input: Item[]; hooks: GameHooks; tty: boolean }
export interface Cmdlet {
  spec: CmdletSpec;
  synopsis: string;
  syntax: string;
  examples?: string[];
  notes?: string;
  /** receives raw tokens instead of bound parameters */
  raw?: boolean;
  /** a game command rather than a PowerShell cmdlet */
  game?: boolean;
  run(ctx: Ctx): Item[];
}

const date = (t: number | null): PsValue => (t === null ? null : new PsDate(t));
const notFound = (id: string): PsError => new PsError(`Cannot find an object with identity: '${id}' under: '${DOMAIN_DN}'.`);
const str = (v: Bound[string]): string | undefined => (typeof v === 'string' ? v : undefined);
const refOf = (it: Item): Ref | undefined => (typeof it === 'string' ? undefined : (it.ref as Ref | undefined));

// ---------------------------------------------------------------- object views
const USER_DEFAULT = ['DistinguishedName', 'Enabled', 'GivenName', 'Name', 'ObjectClass', 'SamAccountName', 'Surname', 'UserPrincipalName'];
const GROUP_DEFAULT = ['DistinguishedName', 'GroupCategory', 'GroupScope', 'Name', 'ObjectClass', 'SamAccountName'];
const COMPUTER_DEFAULT = ['DistinguishedName', 'DNSHostName', 'Enabled', 'Name', 'ObjectClass', 'SamAccountName'];
const OU_DEFAULT = ['DistinguishedName', 'Name', 'ObjectClass'];

function full(dir: Directory, o: AdObject): Record<string, PsValue> {
  const dn = dir.dn(o);
  if (o.kind === 'user') {
    return {
      DistinguishedName: dn, Enabled: o.enabled, GivenName: o.given, Name: userName(o), ObjectClass: 'user', SamAccountName: o.sam,
      Surname: o.surname, UserPrincipalName: `${o.sam}@${DOMAIN}`, Created: date(o.created), Department: o.department,
      Description: o.description, LastLogonDate: date(o.lastLogon), LockedOut: o.lockedOut,
      MemberOf: dir.groupsOf(o.sam).map((g) => dir.dn(g)), PasswordExpired: o.mustChange,
      PasswordLastSet: o.mustChange ? null : date(o.pwdLastSet), PasswordNeverExpires: o.pwdNeverExpires, Title: o.title,
    };
  }
  if (o.kind === 'group') {
    return {
      DistinguishedName: dn, GroupCategory: 'Security', GroupScope: o.scope, Name: o.name, ObjectClass: 'group', SamAccountName: o.name,
      Description: o.description, Members: o.members.map((m) => memberDn(dir, m)),
    };
  }
  if (o.kind === 'computer') {
    return {
      DistinguishedName: dn, DNSHostName: `${o.name.toLowerCase()}.${DOMAIN}`, Enabled: o.enabled, Name: o.name, ObjectClass: 'computer',
      SamAccountName: `${o.name}$`, LastLogonDate: date(o.lastLogon), OperatingSystem: o.os,
    };
  }
  return {
    DistinguishedName: dn, Name: o.name, ObjectClass: o.container ? 'container' : 'organizationalUnit', Description: o.description,
    LinkedGroupPolicyObjects: o.links.map((l) => l.gpo), ProtectedFromAccidentalDeletion: !o.container,
  };
}
const memberObject = (dir: Directory, m: string): AdObject | undefined => dir.findUser(m) ?? dir.findGroup(m) ?? dir.findComputer(m);
const memberDn = (dir: Directory, m: string): string => { const o = memberObject(dir, m); return o ? dir.dn(o) : m; };

function view(dir: Directory, o: AdObject, defaults: string[], extra: string[] | undefined): PsObject {
  const all = full(dir, o);
  let keys = defaults;
  if (extra) {
    if (extra.includes('*')) keys = Object.keys(all);
    else {
      const wanted = extra.map((e) => {
        const k = Object.keys(all).find((x) => x.toLowerCase() === e.toLowerCase());
        if (!k) throw new PsError('One or more properties are invalid.\r\nParameter name: ' + e);
        return k;
      });
      keys = [...new Set([...defaults, ...wanted])];
    }
    keys = [...keys].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }
  return { props: Object.fromEntries(keys.map((k) => [k, all[k]])), show: keys, list: true, ref: o };
}

function searchBase(dir: Directory, base: string | undefined): string {
  if (base === undefined) return DOMAIN_DN;
  if (!dir.isContainer(base)) throw new PsError('Directory object not found');
  return base;
}

/** Shared implementation of Get-ADUser / Get-ADGroup / Get-ADComputer / Get-ADOrganizationalUnit. */
function getter<T extends AdObject>(
  kind: T['kind'], defaults: string[], pool: (d: Directory) => T[], find: (d: Directory, id: string) => T | undefined,
): (ctx: Ctx) => Item[] {
  return ({ dir, p, input }) => {
    const extra = p.Properties as string[] | undefined;
    const id = str(p.Identity);
    if (id !== undefined) {
      const o = find(dir, id);
      if (!o) throw notFound(id);
      return [view(dir, o, defaults, extra)];
    }
    const piped = input.map(refOf).filter((r): r is T => r?.kind === kind);
    if (piped.length) return piped.map((o) => view(dir, o, defaults, extra));
    const filter = str(p.Filter);
    if (filter === undefined) throw new PsError('Provide -Identity, or -Filter to search (everything: -Filter *).');
    const test = compileFilter(filter);
    const base = searchBase(dir, str(p.SearchBase));
    return pool(dir).filter((o) => dir.under(o, base)).filter((o) => {
      const all = full(dir, o);
      return test((name) => { const k = Object.keys(all).find((x) => x.toLowerCase() === name.toLowerCase()); return k ? all[k] : undefined; });
    }).map((o) => view(dir, o, defaults, extra));
  };
}
const GET_PARAMS: CmdletSpec = { params: { Identity: 'string', Filter: 'string', Properties: 'list', SearchBase: 'string' }, positional: ['Identity'] };

/** Accounts named by -Identity or arriving on the pipeline. */
function accounts(ctx: Ctx): (AdUser | AdComputer)[] {
  const id = str(ctx.p.Identity);
  if (id !== undefined) {
    const o = ctx.dir.findUser(id) ?? ctx.dir.findComputer(id);
    if (!o) throw notFound(id);
    return [o];
  }
  const piped = ctx.input.map(refOf).filter((r): r is AdUser | AdComputer => r?.kind === 'user' || r?.kind === 'computer');
  if (piped.length === 0) throw new PsError('Missing mandatory parameter: Identity (or pipe accounts into this cmdlet).');
  return piped;
}
function users(ctx: Ctx): AdUser[] {
  const list = accounts(ctx);
  const bad = list.find((a) => a.kind !== 'user');
  if (bad) throw new PsError(`'${bad.name}' is not a user account.`);
  return list as AdUser[];
}
function need(p: Bound, key: string): string {
  const v = str(p[key]);
  if (v === undefined || v === '') throw new PsError(`Missing mandatory parameter: ${key}.`);
  return v;
}
function gpoFrom(ctx: Ctx): Gpo {
  const name = str(ctx.p.Name);
  if (name !== undefined) {
    const g = ctx.dir.findGpo(name);
    if (!g) throw new PsError(`A GPO with the name '${name}' was not found in the ${DOMAIN} domain.`);
    return g;
  }
  const piped = ctx.input.map(refOf).find((r): r is { kind: 'gpo'; gpo: Gpo } => r?.kind === 'gpo');
  if (!piped) throw new PsError('Missing mandatory parameter: Name.');
  return piped.gpo;
}
const gpoView = (g: Gpo): PsObject => ({
  props: {
    DisplayName: g.name, DomainName: DOMAIN, Owner: 'CORP\\Domain Admins', Id: g.id, GpoStatus: 'AllSettingsEnabled',
    Description: g.description, CreationTime: date(g.created), ModificationTime: date(g.modified),
  },
  show: ['DisplayName', 'DomainName', 'Owner', 'Id', 'GpoStatus', 'Description', 'CreationTime', 'ModificationTime'], list: true, ref: { kind: 'gpo', gpo: g },
});
function linkTarget(dir: Directory, target: string) {
  const links = dir.linksOf(target);
  if (links) return links;
  if (dir.isContainer(target)) throw new PsError(`Cannot link a GPO to '${target}': it is a container, not an organizational unit. Only sites, domains and OUs can have GPO links.`);
  throw new PsError(`There is no such object on the server: '${target}'.`);
}
const hook = (name: keyof GameHooks, synopsis: string): Cmdlet => ({
  spec: { params: {} }, synopsis, syntax: name, game: true,
  run: ({ hooks }) => { const fn = hooks[name]; if (!fn) throw new PsError('Only available inside the game.'); return [fn().replace(/\n$/, '')]; },
});

// ---------------------------------------------------------------- cmdlet table
export const CMDLETS: Record<string, Cmdlet> = {
  'Get-ADUser': {
    spec: GET_PARAMS, synopsis: 'Gets one or more Active Directory users.',
    syntax: 'Get-ADUser [-Identity] <sam|DN> [-Properties <list|*>]\n    Get-ADUser -Filter <filter> [-SearchBase <DN>] [-Properties <list|*>]',
    examples: ['Get-ADUser mlopez -Properties LockedOut,PasswordLastSet', "Get-ADUser -Filter 'Enabled -eq $false'", 'Get-ADUser -Filter * -Properties LastLogonDate | Sort-Object LastLogonDate | Select-Object Name,LastLogonDate'],
    notes: 'Only a default set of properties is returned. Ask for others with -Properties, or they will be empty further down the pipeline.',
    run: getter<AdUser>('user', USER_DEFAULT, (d) => d.users, (d, id) => d.findUser(id)),
  },
  'Get-ADGroup': {
    spec: GET_PARAMS, synopsis: 'Gets one or more Active Directory groups.',
    syntax: 'Get-ADGroup [-Identity] <name|DN> [-Properties <list|*>]\n    Get-ADGroup -Filter <filter>',
    examples: ["Get-ADGroup 'Domain Admins' -Properties Members"],
    run: getter<AdGroup>('group', GROUP_DEFAULT, (d) => d.groups, (d, id) => d.findGroup(id)),
  },
  'Get-ADComputer': {
    spec: GET_PARAMS, synopsis: 'Gets one or more Active Directory computers.',
    syntax: 'Get-ADComputer [-Identity] <name|DN> [-Properties <list|*>]\n    Get-ADComputer -Filter <filter> [-SearchBase <DN>]',
    examples: ["Get-ADComputer -Filter 'Name -like \"WS-*\"' | Select-Object Name,DistinguishedName"],
    run: getter<AdComputer>('computer', COMPUTER_DEFAULT, (d) => d.computers, (d, id) => d.findComputer(id)),
  },
  'Get-ADOrganizationalUnit': {
    spec: GET_PARAMS, synopsis: 'Gets one or more organizational units.',
    syntax: 'Get-ADOrganizationalUnit -Filter * [-Properties <list|*>]\n    Get-ADOrganizationalUnit [-Identity] <DN>',
    examples: ['Get-ADOrganizationalUnit -Filter * | Select-Object Name,DistinguishedName'],
    notes: 'Built-in containers such as CN=Computers and CN=Users are not OUs and are not listed. GPOs cannot be linked to them.',
    run: getter<AdOU>('ou', OU_DEFAULT, (d) => d.ous.filter((o) => !o.container), (d, id) => { const o = d.findOU(id); return o && !o.container ? o : undefined; }),
  },
  'Get-ADObject': {
    spec: { params: { Filter: 'string', SearchBase: 'string', Identity: 'string' }, positional: ['Identity'] },
    synopsis: 'Gets directory objects of any type.', syntax: 'Get-ADObject -Filter <filter> [-SearchBase <DN>]',
    examples: ["Get-ADObject -Filter * -SearchBase 'CN=Computers,DC=corp,DC=example'"],
    run: ({ dir, p }) => {
      const id = str(p.Identity);
      const mk = (o: AdObject): PsObject => {
        const all = full(dir, o);
        return { props: { DistinguishedName: all.DistinguishedName, Name: all.Name, ObjectClass: all.ObjectClass }, show: ['DistinguishedName', 'Name', 'ObjectClass'], list: true, ref: o };
      };
      if (id !== undefined) { const o = dir.byDn(id); if (!o) throw notFound(id); return [mk(o)]; }
      const test = compileFilter(need(p, 'Filter'));
      const base = searchBase(dir, str(p.SearchBase));
      return dir.all().filter((o) => dir.under(o, base)).filter((o) => {
        const all = full(dir, o);
        return test((n) => { const k = Object.keys(all).find((x) => x.toLowerCase() === n.toLowerCase()); return k ? all[k] : undefined; });
      }).map(mk);
    },
  },
  'Get-ADGroupMember': {
    spec: { params: { Identity: 'string', Recursive: 'switch' }, positional: ['Identity'] },
    synopsis: 'Gets the members of a group.', syntax: 'Get-ADGroupMember [-Identity] <group>',
    examples: ["Get-ADGroupMember 'Domain Admins' | Select-Object Name,SamAccountName"],
    run: ({ dir, p }) => {
      const id = need(p, 'Identity');
      const g = dir.findGroup(id);
      if (!g) throw notFound(id);
      return g.members.map((m) => memberObject(dir, m)).filter((o): o is AdObject => !!o).map((o) => {
        const all = full(dir, o);
        return { props: { distinguishedName: all.DistinguishedName, name: all.Name, objectClass: all.ObjectClass, SamAccountName: all.SamAccountName ?? all.Name }, show: ['distinguishedName', 'name', 'objectClass', 'SamAccountName'], list: true, ref: o };
      });
    },
  },
  'Search-ADAccount': {
    spec: { params: { LockedOut: 'switch', AccountDisabled: 'switch', AccountInactive: 'switch', PasswordNeverExpires: 'switch', TimeSpan: 'string', UsersOnly: 'switch', ComputersOnly: 'switch' } },
    synopsis: 'Finds accounts by state: locked out, disabled, inactive, or with non-expiring passwords.',
    syntax: 'Search-ADAccount -LockedOut | -AccountDisabled | -PasswordNeverExpires | -AccountInactive [-TimeSpan <days>] [-UsersOnly | -ComputersOnly]',
    examples: ['Search-ADAccount -LockedOut', 'Search-ADAccount -AccountInactive -TimeSpan 90 -UsersOnly | Select-Object Name,Enabled,LastLogonDate'],
    notes: '-AccountInactive also returns accounts that are already disabled; check the Enabled column.',
    run: ({ dir, p }) => {
      const modes = ['LockedOut', 'AccountDisabled', 'AccountInactive', 'PasswordNeverExpires'].filter((m) => p[m]);
      if (modes.length !== 1) throw new PsError('Parameter set cannot be resolved. Specify exactly one of -LockedOut, -AccountDisabled, -AccountInactive, -PasswordNeverExpires.');
      const days = p.TimeSpan === undefined ? 15 : parseInt(String(p.TimeSpan), 10);
      if (Number.isNaN(days)) throw new PsError(`Cannot convert value "${p.TimeSpan}" to type "System.TimeSpan".`);
      const pool: (AdUser | AdComputer)[] = [...(p.ComputersOnly ? [] : dir.users), ...(p.UsersOnly ? [] : dir.computers)];
      const test = (a: AdUser | AdComputer): boolean => {
        if (modes[0] === 'LockedOut') return a.kind === 'user' && a.lockedOut;
        if (modes[0] === 'AccountDisabled') return !a.enabled;
        if (modes[0] === 'PasswordNeverExpires') return a.kind === 'user' && a.pwdNeverExpires;
        return a.lastLogon === null || a.lastLogon < dir.now - days * DAY;
      };
      const show = ['AccountExpirationDate', 'DistinguishedName', 'Enabled', 'LastLogonDate', 'LockedOut', 'Name', 'ObjectClass', 'PasswordExpired', 'PasswordNeverExpires', 'SamAccountName'];
      return pool.filter(test).map((a) => {
        const all = full(dir, a);
        return { props: Object.fromEntries(show.map((k) => [k, all[k] ?? (k === 'AccountExpirationDate' ? null : false)])), show, list: true, ref: a };
      });
    },
  },
  'Set-ADAccountPassword': {
    spec: { params: { Identity: 'string', Reset: 'switch', NewPassword: 'string', OldPassword: 'string' }, positional: ['Identity'] },
    synopsis: 'Sets the password of an account. With -Reset, an administrator sets a new one without knowing the old one.',
    syntax: "Set-ADAccountPassword [-Identity] <user> -Reset -NewPassword (ConvertTo-SecureString '<password>' -AsPlainText -Force)",
    examples: ["Set-ADAccountPassword mlopez -Reset -NewPassword (ConvertTo-SecureString 'Spring-Tulip-2026!' -AsPlainText -Force)"],
    notes: 'A reset stamps the password as freshly set, which clears "must change at next logon". Set that flag after the reset, not before. A reset does not unlock a locked account. (Simulator: a plain quoted string is also accepted for -NewPassword.)',
    run: (ctx) => {
      const targets = users(ctx);
      if (!ctx.p.Reset) throw new PsError('Changing a password needs -OldPassword. To set a new password as an administrator, add -Reset.');
      const raw = ctx.p.NewPassword as string | SecureString | undefined;
      if (raw === undefined) throw new PsError('-NewPassword is required here (the real cmdlet would prompt for it).');
      const pw = typeof raw === 'string' ? raw : raw.secure;
      if (!ctx.dir.passwordOk(pw)) throw new PsError('The password does not meet the length, complexity, or history requirement of the domain.');
      for (const u of targets) { u.pwdLastSet = ctx.dir.now; u.mustChange = false; u.pwdResets++; }
      return [];
    },
  },
  'Set-ADUser': {
    spec: { params: { Identity: 'string', ChangePasswordAtLogon: 'bool', PasswordNeverExpires: 'bool', Enabled: 'bool', Description: 'string', Title: 'string', Department: 'string' }, positional: ['Identity'] },
    synopsis: 'Modifies a user account.',
    syntax: 'Set-ADUser [-Identity] <user> [-ChangePasswordAtLogon <bool>] [-Enabled <bool>] [-PasswordNeverExpires <bool>] [-Description <text>]',
    examples: ['Set-ADUser mlopez -ChangePasswordAtLogon $true', "Set-ADUser jdoe -Enabled $false -Description 'Left 2026-01'"],
    run: (ctx) => {
      const { p } = ctx;
      for (const u of users(ctx)) {
        const never = typeof p.PasswordNeverExpires === 'boolean' ? p.PasswordNeverExpires : u.pwdNeverExpires;
        if (p.ChangePasswordAtLogon === true && never) throw new PsError('ChangePasswordAtLogon cannot be set to true for an account whose password never expires.');
        if (typeof p.PasswordNeverExpires === 'boolean') u.pwdNeverExpires = p.PasswordNeverExpires;
        if (typeof p.ChangePasswordAtLogon === 'boolean') { u.mustChange = p.ChangePasswordAtLogon; if (!u.mustChange) u.pwdLastSet = ctx.dir.now; }
        if (typeof p.Enabled === 'boolean') u.enabled = p.Enabled;
        if (typeof p.Description === 'string') u.description = p.Description;
        if (typeof p.Title === 'string') u.title = p.Title;
        if (typeof p.Department === 'string') u.department = p.Department;
      }
      return [];
    },
  },
  'Unlock-ADAccount': {
    spec: { params: { Identity: 'string' }, positional: ['Identity'] }, synopsis: 'Unlocks an account that was locked out by too many failed logons.',
    syntax: 'Unlock-ADAccount [-Identity] <user>', examples: ['Unlock-ADAccount mlopez', 'Search-ADAccount -LockedOut | Unlock-ADAccount'],
    run: (ctx) => { for (const u of users(ctx)) u.lockedOut = false; return []; },
  },
  'Enable-ADAccount': {
    spec: { params: { Identity: 'string' }, positional: ['Identity'] }, synopsis: 'Enables a user or computer account.',
    syntax: 'Enable-ADAccount [-Identity] <account>', run: (ctx) => { for (const a of accounts(ctx)) a.enabled = true; return []; },
  },
  'Disable-ADAccount': {
    spec: { params: { Identity: 'string' }, positional: ['Identity'] }, synopsis: 'Disables a user or computer account. The account and its group memberships are kept.',
    syntax: 'Disable-ADAccount [-Identity] <account>', examples: ['Disable-ADAccount jdoe'],
    notes: 'Disable first, delete later: a disabled account can be restored instantly if the decision was wrong.',
    run: (ctx) => { for (const a of accounts(ctx)) a.enabled = false; return []; },
  },
  'Add-ADGroupMember': {
    spec: { params: { Identity: 'string', Members: 'list' }, positional: ['Identity', 'Members'] }, synopsis: 'Adds members to a group.',
    syntax: 'Add-ADGroupMember [-Identity] <group> [-Members] <account[,account...]>', examples: ['Add-ADGroupMember Helpdesk -Members omartin'],
    run: ({ dir, p }) => {
      const id = need(p, 'Identity');
      const g = dir.findGroup(id);
      if (!g) throw notFound(id);
      const members = p.Members as string[] | undefined;
      if (!members) throw new PsError('Missing mandatory parameter: Members.');
      const resolved = members.map((m) => { const o = memberObject(dir, m); if (!o) throw notFound(m); return o.kind === 'user' ? o.sam : o.name; });
      for (const m of resolved) if (g.members.some((x) => x.toLowerCase() === m.toLowerCase())) throw new PsError('The specified account name is already a member of the group');
      g.members.push(...resolved);
      return [];
    },
  },
  'Remove-ADGroupMember': {
    spec: { params: { Identity: 'string', Members: 'list' }, positional: ['Identity', 'Members'] }, synopsis: 'Removes members from a group.',
    syntax: 'Remove-ADGroupMember [-Identity] <group> [-Members] <account[,account...]> [-Confirm:$false]',
    examples: ["Remove-ADGroupMember 'Domain Admins' -Members tjones -Confirm:$false"],
    notes: 'The real cmdlet asks for confirmation unless -Confirm:$false is given. The simulator never prompts.',
    run: ({ dir, p }) => {
      const id = need(p, 'Identity');
      const g = dir.findGroup(id);
      if (!g) throw notFound(id);
      const members = p.Members as string[] | undefined;
      if (!members) throw new PsError('Missing mandatory parameter: Members.');
      const resolved = members.map((m) => { const o = memberObject(dir, m); if (!o) throw notFound(m); return (o.kind === 'user' ? o.sam : o.name).toLowerCase(); });
      for (const m of resolved) if (!g.members.some((x) => x.toLowerCase() === m)) throw new PsError('The specified account name is not a member of the group');
      g.members = g.members.filter((x) => !resolved.includes(x.toLowerCase()));
      return [];
    },
  },
  'New-ADOrganizationalUnit': {
    spec: { params: { Name: 'string', Path: 'string', Description: 'string', ProtectedFromAccidentalDeletion: 'bool' }, positional: ['Name'] },
    synopsis: 'Creates an organizational unit.', syntax: 'New-ADOrganizationalUnit [-Name] <name> [-Path <parent DN>]',
    examples: ['New-ADOrganizationalUnit -Name Workstations', "New-ADOrganizationalUnit -Name Laptops -Path 'OU=Workstations,DC=corp,DC=example'"],
    notes: 'Without -Path the OU is created at the domain root.',
    run: ({ dir, p }) => {
      const name = need(p, 'Name');
      const parent = str(p.Path) ?? DOMAIN_DN;
      if (!dir.isContainer(parent)) throw new PsError('Directory object not found');
      const canonical = sameDn(parent, DOMAIN_DN) ? DOMAIN_DN : dir.dn(dir.findOU(parent)!);
      if (dir.findOU(`OU=${name},${canonical}`)) throw new PsError('An attempt was made to add an object to the directory with a name that is already in use');
      dir.ou(name, canonical, { description: str(p.Description) ?? '' });
      return [];
    },
  },
  'Move-ADObject': {
    spec: { params: { Identity: 'string', TargetPath: 'string' }, positional: ['Identity'] },
    synopsis: 'Moves an object (or an OU and its contents) to another container.',
    syntax: 'Move-ADObject [-Identity] <DN> -TargetPath <DN>',
    examples: ["Move-ADObject 'CN=WS-001,CN=Computers,DC=corp,DC=example' -TargetPath 'OU=Workstations,DC=corp,DC=example'", "Get-ADComputer WS-001 | Move-ADObject -TargetPath 'OU=Workstations,DC=corp,DC=example'"],
    notes: '-Identity must be a distinguished name. To use a short name, pipe the object in from a Get-AD* cmdlet.',
    run: ({ dir, p, input }) => {
      const target = need(p, 'TargetPath');
      const id = str(p.Identity);
      let objs: AdObject[];
      if (id !== undefined) { const o = dir.byDn(id); if (!o) throw notFound(id); objs = [o]; }
      else {
        objs = input.map(refOf).filter((r): r is AdObject => !!r && r.kind !== 'gpo');
        if (objs.length === 0) throw new PsError('Missing mandatory parameter: Identity (or pipe objects into this cmdlet).');
      }
      if (!dir.isContainer(target)) throw new PsError('Directory object not found');
      const dest = sameDn(target, DOMAIN_DN) ? DOMAIN_DN : dir.dn(dir.findOU(target)!);
      for (const o of objs) {
        const old = dir.dn(o);
        if ((',' + dest.toLowerCase()).endsWith(',' + old.toLowerCase())) throw new PsError('The operation could not be performed because the object\'s parent is either uninstantiated or deleted');
        const kids = dir.all().filter((c) => c !== o && dir.under(c, old));
        const oldParents = kids.map((c) => c.parent);
        o.parent = dest;
        const now = dir.dn(o);
        kids.forEach((c, k) => { c.parent = oldParents[k].slice(0, oldParents[k].length - old.length) + now; });
      }
      return [];
    },
  },
  'Get-GPO': {
    spec: { params: { Name: 'string', All: 'switch' }, positional: ['Name'] }, synopsis: 'Gets one GPO or all GPOs in the domain.',
    syntax: 'Get-GPO -All\n    Get-GPO [-Name] <name>', examples: ['Get-GPO -All | Select-Object DisplayName,Description'],
    run: (ctx) => {
      if (ctx.p.All) return ctx.dir.gpos.map(gpoView);
      return [gpoView(gpoFrom(ctx))];
    },
  },
  'New-GPO': {
    spec: { params: { Name: 'string', Comment: 'string' }, positional: ['Name'] }, synopsis: 'Creates an empty GPO. It has no effect until it is linked.',
    syntax: 'New-GPO [-Name] <name> [-Comment <text>]',
    run: ({ dir, p }) => {
      const name = need(p, 'Name');
      if (dir.findGpo(name)) throw new PsError(`A GPO with the name '${name}' already exists in the ${DOMAIN} domain.`);
      dir.gpo(name, str(p.Comment) ?? '', []);
      const g = dir.findGpo(name)!;
      g.created = g.modified = dir.now;
      return [gpoView(g)];
    },
  },
  'New-GPLink': {
    spec: { params: { Name: 'string', Target: 'string', LinkEnabled: 'yesno', Enforced: 'yesno' }, positional: ['Name'] },
    synopsis: 'Links a GPO to a domain or OU, so its settings apply to the objects inside.',
    syntax: 'New-GPLink [-Name] <gpo> -Target <DN> [-LinkEnabled Yes|No] [-Enforced Yes|No]',
    examples: ["New-GPLink -Name 'Workstation Baseline' -Target 'OU=Workstations,DC=corp,DC=example'"],
    notes: 'A link applies to everything under the target. Link as low in the tree as the policy allows.',
    run: (ctx) => {
      const { dir, p } = ctx;
      const g = gpoFrom(ctx);
      const target = need(p, 'Target');
      const links = linkTarget(dir, target);
      if (links.some((l) => l.gpo === g.name)) throw new PsError(`The GPO named '${g.name}' is already linked to a Scope of Management with Path '${target}'.`);
      const link = { gpo: g.name, enabled: p.LinkEnabled !== false, enforced: p.Enforced === true };
      links.push(link);
      return [{
        props: { GpoId: g.id, DisplayName: g.name, Enabled: link.enabled, Enforced: link.enforced, Target: target, Order: links.length },
        show: ['GpoId', 'DisplayName', 'Enabled', 'Enforced', 'Target', 'Order'], list: true,
      }];
    },
  },
  'Set-GPLink': {
    spec: { params: { Name: 'string', Target: 'string', LinkEnabled: 'yesno', Enforced: 'yesno' }, positional: ['Name'] },
    synopsis: 'Changes an existing GPO link.', syntax: 'Set-GPLink [-Name] <gpo> -Target <DN> [-LinkEnabled Yes|No] [-Enforced Yes|No]',
    run: (ctx) => {
      const g = gpoFrom(ctx);
      const target = need(ctx.p, 'Target');
      const link = linkTarget(ctx.dir, target).find((l) => l.gpo === g.name);
      if (!link) throw new PsError(`The GPO named '${g.name}' is not linked to '${target}'.`);
      if (typeof ctx.p.LinkEnabled === 'boolean') link.enabled = ctx.p.LinkEnabled;
      if (typeof ctx.p.Enforced === 'boolean') link.enforced = ctx.p.Enforced;
      return [];
    },
  },
  'Remove-GPLink': {
    spec: { params: { Name: 'string', Target: 'string' }, positional: ['Name'] }, synopsis: 'Removes a GPO link. The GPO itself is kept.',
    syntax: 'Remove-GPLink [-Name] <gpo> -Target <DN>',
    run: (ctx) => {
      const g = gpoFrom(ctx);
      const target = need(ctx.p, 'Target');
      const links = linkTarget(ctx.dir, target);
      const i = links.findIndex((l) => l.gpo === g.name);
      if (i < 0) throw new PsError(`The GPO named '${g.name}' is not linked to '${target}'.`);
      links.splice(i, 1);
      return [];
    },
  },
  'Get-GPInheritance': {
    spec: { params: { Target: 'string' }, positional: ['Target'] }, synopsis: 'Shows which GPOs are linked to, and inherited by, a domain or OU.',
    syntax: 'Get-GPInheritance [-Target] <DN>', examples: ["Get-GPInheritance -Target 'OU=Finance,DC=corp,DC=example'"],
    run: ({ dir, p }) => {
      const target = need(p, 'Target');
      const own = linkTarget(dir, target);
      const inherited = [...own];
      const ou = dir.findOU(target);
      for (let parent = ou?.parent; parent; parent = dir.findOU(parent)?.parent) inherited.push(...(dir.linksOf(parent) ?? []));
      const names = (ls: typeof own): string[] => ls.filter((l) => l.enabled).map((l) => l.gpo);
      return [{
        props: { Name: ou ? ou.name : DOMAIN, ContainerType: ou ? 'OU' : 'Domain', Path: target, GpoInheritanceBlocked: 'No', GpoLinks: names(own), InheritedGpoLinks: names(inherited) },
        show: ['Name', 'ContainerType', 'Path', 'GpoInheritanceBlocked', 'GpoLinks', 'InheritedGpoLinks'], list: true,
      }];
    },
  },
  'Get-GPOReport': {
    spec: { params: { Name: 'string', ReportType: 'string' }, positional: ['Name'] }, synopsis: 'Shows the settings a GPO configures.',
    syntax: 'Get-GPOReport [-Name] <gpo>', notes: 'Simulator: prints a short text summary instead of an XML or HTML report.',
    run: (ctx) => {
      const g = gpoFrom(ctx);
      return [`GPO: ${g.name}\nDescription: ${g.description || '(none)'}\nSettings:\n${g.settings.length ? g.settings.map((s) => `  - ${s}`).join('\n') : '  (no settings configured)'}`];
    },
  },
  'Get-ADDefaultDomainPasswordPolicy': {
    spec: { params: {} }, synopsis: 'Shows the domain password and lockout policy.', syntax: 'Get-ADDefaultDomainPasswordPolicy',
    run: ({ dir }) => [{
      props: {
        ComplexityEnabled: dir.policy.complexity, DistinguishedName: DOMAIN_DN, LockoutDuration: '00:30:00', LockoutThreshold: dir.policy.lockoutThreshold,
        MaxPasswordAge: `${dir.policy.maxAgeDays}.00:00:00`, MinPasswordAge: '1.00:00:00', MinPasswordLength: dir.policy.minLength, PasswordHistoryCount: dir.policy.historyCount,
      },
      show: ['ComplexityEnabled', 'DistinguishedName', 'LockoutDuration', 'LockoutThreshold', 'MaxPasswordAge', 'MinPasswordAge', 'MinPasswordLength', 'PasswordHistoryCount'], list: true,
    }],
  },

  // ---- pipeline helpers
  'Select-Object': {
    spec: { params: { Property: 'list', First: 'int', Last: 'int', ExpandProperty: 'string' }, positional: ['Property'] },
    synopsis: 'Keeps only the named properties (or the first/last N objects).', syntax: 'Select-Object [-Property] <name[,name...]> [-First <n>] [-Last <n>] [-ExpandProperty <name>]',
    examples: ['Get-ADUser -Filter * | Select-Object Name,Enabled'],
    run: ({ input, p }) => {
      let objs = input.filter((i): i is PsObject => typeof i !== 'string');
      if (typeof p.First === 'number') objs = objs.slice(0, p.First);
      if (typeof p.Last === 'number') objs = objs.slice(-p.Last);
      const expand = str(p.ExpandProperty);
      if (expand) return objs.flatMap((o) => { const v = propOf(o, expand)?.value ?? null; return Array.isArray(v) ? v.map(String) : [v === null ? '' : String(v)]; });
      const props = p.Property as string[] | undefined;
      if (!props) return objs;
      return objs.map((o) => {
        const keys = props.includes('*') ? Object.keys(o.props) : props.map((n) => propOf(o, n)?.key ?? n);
        return { props: Object.fromEntries(keys.map((k) => [k, propOf(o, k)?.value ?? null])), show: keys, ref: o.ref };
      });
    },
  },
  'Where-Object': {
    spec: { params: {} }, raw: true, synopsis: 'Keeps the objects that match a condition.',
    syntax: 'Where-Object { $_.<Property> -eq <value> }\n    Where-Object <Property> -eq|-ne|-like|-lt|-gt <value>', examples: ['Get-ADUser -Filter * | Where-Object { $_.Enabled -eq $false }'],
    notes: 'A property that was not loaded (see Get-ADUser -Properties) is empty here.',
    run: ({ input, args }) => {
      const text = args.length === 1 && args[0].t === 'block' ? args[0].text
        : args.map((a) => (a.t === 'word' ? a.text : a.t === 'string' ? `'${a.text.replace(/'/g, "''")}'` : '')).join(' ');
      const test = compileFilter(text);
      return input.filter((i): i is PsObject => typeof i !== 'string').filter((o) => test((n) => propOf(o, n)?.value ?? null));
    },
  },
  'Sort-Object': {
    spec: { params: { Property: 'list', Descending: 'switch' }, positional: ['Property'] }, synopsis: 'Sorts objects by a property.',
    syntax: 'Sort-Object [-Property] <name> [-Descending]',
    run: ({ input, p }) => {
      const objs = input.filter((i): i is PsObject => typeof i !== 'string');
      const props = (p.Property as string[] | undefined) ?? [objs[0]?.show[0] ?? 'Name'];
      const sorted = [...objs].sort((a, b) => {
        for (const k of props) {
          const x = propOf(a, k)?.value ?? null, y = propOf(b, k)?.value ?? null;
          const c = x === null && y !== null ? -1 : y === null && x !== null ? 1 : sortValues(x, y);
          if (c !== 0) return c;
        }
        return 0;
      });
      return p.Descending ? sorted.reverse() : sorted;
    },
  },
  'Measure-Object': {
    spec: { params: {} }, synopsis: 'Counts the objects in the pipeline.', syntax: 'Measure-Object', examples: ['Get-ADUser -Filter * | Measure-Object'],
    run: ({ input }) => [{ props: { Count: input.length }, show: ['Count'], list: true }],
  },
  'Format-Table': {
    spec: { params: { Property: 'list', AutoSize: 'switch', Wrap: 'switch' }, positional: ['Property'] }, synopsis: 'Shows objects as a table.',
    syntax: 'Format-Table [[-Property] <name[,name...]>]',
    run: ({ input, p }) => { const o = input.filter((i): i is PsObject => typeof i !== 'string'); return o.length ? [formatTable(o, p.Property as string[] | undefined)] : []; },
  },
  'Format-List': {
    spec: { params: { Property: 'list' }, positional: ['Property'] }, synopsis: 'Shows objects as a list of properties.', syntax: 'Format-List [[-Property] <name[,name...]>]',
    run: ({ input, p }) => {
      const o = input.filter((i): i is PsObject => typeof i !== 'string');
      const props = p.Property as string[] | undefined;
      return o.length ? [formatList(o, props?.includes('*') ? undefined : props)] : [];
    },
  },

  // ---- shell basics
  'Get-Help': {
    spec: { params: { Name: 'string', Examples: 'switch', Full: 'switch' }, positional: ['Name'] }, synopsis: 'Explains a cmdlet. Without a name, lists everything available.',
    syntax: 'Get-Help [<cmdlet>]',
    run: ({ p }) => {
      const name = str(p.Name);
      if (!name) return [helpIndex()];
      const key = resolveCmdlet(name);
      if (!key) throw new PsError(`Get-Help could not find ${name} in a help file in this session.`);
      return [helpFor(key)];
    },
  },
  'Get-Command': { spec: { params: {} }, synopsis: 'Lists the available cmdlets.', syntax: 'Get-Command', run: () => [helpIndex()] },
  'Get-Date': { spec: { params: {} }, synopsis: 'Shows the (simulated, frozen) date and time.', syntax: 'Get-Date', run: ({ dir }) => [new PsDate(dir.now).toString()] },
  'Get-History': {
    spec: { params: {} }, synopsis: 'Shows the commands run in this level.', syntax: 'Get-History',
    run: ({ state }) => state.history.map((h, i) => `${String(i + 1).padStart(4)} ${h}`),
  },
  'Clear-Host': { spec: { params: {} }, synopsis: 'Clears the screen.', syntax: 'Clear-Host', run: ({ tty }) => (tty ? ['\x1b[H\x1b[2J\x1b[3J'] : []) },
  whoami: { spec: { params: {} }, synopsis: 'Shows who you are logged on as.', syntax: 'whoami', run: () => ['corp\\adm.analyst'] },
  hostname: { spec: { params: {} }, synopsis: 'Shows the name of this computer.', syntax: 'hostname', run: () => ['MGMT01'] },

  // ---- game commands
  submit: {
    spec: { params: {} }, raw: true, game: true, synopsis: 'Submit an answer, for tasks that ask a question.', syntax: 'submit <answer>',
    run: ({ args, state }) => {
      const answer = args.map((a) => ('text' in a ? a.text : '')).join(' ').trim();
      if (!answer) throw new PsError('usage: submit <answer>');
      state.submitted.push(answer);
      return [`Answer submitted: ${answer}`];
    },
  },
  hint: hook('hint', 'Reveal the next hint (costs points).'),
  mission: hook('mission', 'Show the briefing again.'),
  levels: hook('levels', 'List tasks and progress.'),
  reset: hook('reset', 'Restart this task from its initial state.'),
  exit: hook('exit', 'Leave this console and return to the map.'),
};

export const ALIASES: Record<string, string> = {
  select: 'Select-Object', where: 'Where-Object', sort: 'Sort-Object', measure: 'Measure-Object', ft: 'Format-Table', fl: 'Format-List',
  cls: 'Clear-Host', clear: 'Clear-Host', help: 'Get-Help', man: 'Get-Help', gcm: 'Get-Command', history: 'Get-History',
};
export function resolveCmdlet(name: string): string | undefined {
  const k = name.toLowerCase();
  const alias = ALIASES[k];
  return alias ?? Object.keys(CMDLETS).find((c) => c.toLowerCase() === k);
}

function helpFor(key: string): string {
  const c = CMDLETS[key];
  let out = `\nNAME\n    ${key}\n\nSYNOPSIS\n    ${c.synopsis}\n\nSYNTAX\n    ${c.syntax}\n`;
  if (c.examples?.length) out += `\nEXAMPLES\n${c.examples.map((e) => `    ${e}`).join('\n')}\n`;
  if (c.notes) out += `\nNOTES\n    ${c.notes}\n`;
  return out;
}
function helpIndex(): string {
  const names = Object.keys(CMDLETS);
  const section = (title: string, list: string[]): string => `${title}\n${list.map((n) => `  ${n.padEnd(34)} ${CMDLETS[n].synopsis}`).join('\n')}\n`;
  return '\n' + section('Cmdlets (Get-Help <name> for details)', names.filter((n) => !CMDLETS[n].game)) +
    '\n' + section('Game commands', names.filter((n) => CMDLETS[n].game)) +
    '\nSyntax\n  Verb-Noun -Parameter value     names are case-insensitive; Tab completes them\n' +
    '  a | b                          pipe objects from a into b\n' +
    "  'text' or \"text\"               quote values that contain spaces\n" +
    '  $true $false                   Boolean values\n' +
    `  Aliases: ${Object.keys(ALIASES).join(', ')}\n`;
}
