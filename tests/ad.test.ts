import { describe, expect, it } from 'vitest';
import { baseDirectory, DOMAIN_DN, Directory } from '../src/ad/directory';
import { AdShell } from '../src/ad/session';
import { compileFilter, parse, PsDate, PsValue, tokenize } from '../src/ad/powershell';
import { createSession } from '../src/levels/engine';
import { AD_LEVELS } from '../src/ad/levels';
import { at } from '../src/levels/builders';

const NOW = at('2026-11-23T09:00:00Z');
const mk = () => {
  const dir = baseDirectory(NOW);
  const sh = new AdShell({ dir, submitted: [], history: [] });
  return { dir, sh, run: (l: string) => sh.run(l), out: (l: string) => sh.run(l).output };
};
const WS_OU = `OU=Workstations,${DOMAIN_DN}`;

describe('PowerShell-style parsing', () => {
  it('tokenizes quotes, expressions, blocks, pipes and commas', () => {
    expect(tokenize(`Get-ADUser -Filter 'Name -like "a*"' | select Name,Enabled`).map((t) => ('text' in t ? `${t.t}:${t.text}` : t.t))).toEqual([
      'word:Get-ADUser', 'word:-Filter', 'string:Name -like "a*"', 'pipe', 'word:select', 'word:Name', 'comma', 'word:Enabled',
    ]);
    expect(tokenize("x (ConvertTo-SecureString 'a)b' -Force) { $_.A -eq 1 } # note").map((t) => t.t)).toEqual(['word', 'expr', 'block']);
    expect(tokenize("'it''s'")[0]).toEqual({ t: 'string', text: "it's" });
    expect(tokenize('"a`"b"')[0]).toEqual({ t: 'string', text: 'a"b' });
  });
  it('splits statements and pipelines', () => {
    const st = parse('Get-ADUser x | Select-Object Name; whoami');
    expect(st.map((p) => p.map((s) => s.name))).toEqual([['Get-ADUser', 'Select-Object'], ['whoami']]);
  });
  it.each([
    ["Get-ADUser 'abc", /missing the terminator/], ['Get-ADUser (abc', /Missing closing/], ['| whoami', /empty pipe/], ['whoami |', /empty pipe/],
    ["'x' | whoami", /cmdlet name/],
  ])('rejects %s', (line, msg) => expect(() => parse(line)).toThrow(msg));
  it('filters: operators, wildcards, booleans, -and / -or', () => {
    const o: Record<string, PsValue> = { Name: 'WS-001', Enabled: false, Count: 5, When: new PsDate(1000), Empty: null };
    const t = (f: string): boolean => compileFilter(f)((k) => o[k]);
    expect([t('*'), t('Name -like "WS-*"'), t("Name -eq 'ws-001'"), t('Enabled -eq $false'), t('Enabled -ne $false')]).toEqual([true, true, true, true, false]);
    expect([t('Count -gt 4'), t('Count -lt 5'), t('Count -ge 5 -and Name -like "SRV*"'), t('Count -lt 1 -or Name -notlike "SRV*"')]).toEqual([true, false, false, true]);
    expect([t('$_.Name -eq "WS-001"'), t('Missing -eq 1'), t('Empty -gt 3')]).toEqual([true, false, false]);
    expect(() => compileFilter('Name')).toThrow(/Error parsing query/);
    expect(() => compileFilter('Name -match x')).toThrow(/not supported/);
  });
});

describe('reading the directory', () => {
  it('Get-ADUser shows the default property set as a list', () => {
    expect(mk().out('Get-ADUser mlopez')).toBe([
      '', 'DistinguishedName : CN=Maria Lopez,OU=Finance,DC=corp,DC=example', 'Enabled           : True', 'GivenName         : Maria',
      'Name              : Maria Lopez', 'ObjectClass       : user', 'SamAccountName    : mlopez', 'Surname           : Lopez',
      'UserPrincipalName : mlopez@corp.example', '', '',
    ].join('\n'));
  });
  it('extra properties must be requested, and names are case-insensitive', () => {
    const b = mk();
    const out = b.out('get-aduser MLOPEZ -properties lockedout,Title');
    expect(out).toMatch(/LockedOut +: False/);
    expect(out).toMatch(/Title +: Accountant/);
    expect(b.out('Get-ADUser mlopez | Select-Object Name,Title')).toMatch(/Maria Lopez\s*\n/); // Title not loaded: empty
    expect(b.out('Get-ADUser mlopez -Properties * | Select-Object Name,Title')).toMatch(/Maria Lopez Accountant/);
    expect(b.run('Get-ADUser mlopez -Properties Nope').output).toMatch(/One or more properties are invalid/);
  });
  it('filters, search bases and pipelines', () => {
    const b = mk();
    expect(b.out("Get-ADUser -Filter 'Enabled -eq $false' | Select-Object SamAccountName")).toBe('\nSamAccountName\n--------------\njdoe\n\n');
    expect(b.out(`Get-ADUser -Filter * -SearchBase 'OU=Finance,${DOMAIN_DN}' | Select-Object -ExpandProperty SamAccountName`)).toBe('mlopez\ndnguyen\n');
    expect(b.out('Get-ADUser -Filter * | Measure-Object')).toMatch(/Count : 13/);
    expect(b.out('Get-ADUser -Filter * -Properties LastLogonDate | Sort-Object LastLogonDate | Select-Object SamAccountName -First 2')).toBe('\nSamAccountName\n--------------\njdoe\nrpatel\n\n');
    expect(b.out('Get-ADUser -Filter * | Where-Object { $_.Surname -like "Ch*" } | select SamAccountName | sort SamAccountName -Descending'))
      .toBe('\nSamAccountName\n--------------\nkchen\nadm.kchen\n\n');
    expect(b.out('Get-ADUser -Filter * | where Enabled -eq $false | ft SamAccountName,Enabled')).toBe('\nSamAccountName Enabled\n-------------- -------\njdoe           False\n\n');
    expect(b.out('Get-ADComputer -Filter \'Name -like "WS-*"\' | Select-Object Name,DistinguishedName')).toContain('WS-002 CN=WS-002,CN=Computers,DC=corp,DC=example');
    expect(b.out('Get-ADOrganizationalUnit -Filter * | Select-Object -ExpandProperty Name')).not.toMatch(/Computers|Users/);
    expect(b.out(`Get-ADObject -Filter * -SearchBase 'CN=Computers,${DOMAIN_DN}' | Measure-Object`)).toMatch(/Count : 4/);
    expect(b.out("Get-ADGroupMember 'Domain Admins' | Select-Object SamAccountName")).toBe('\nSamAccountName\n--------------\nAdministrator\nadm.kchen\n\n');
    expect(b.out('Get-ADUser tjones -Properties MemberOf | Select-Object -ExpandProperty MemberOf')).toContain('CN=Sales-Staff,OU=Sales,DC=corp,DC=example');
  });
  it('errors read like the real cmdlets', () => {
    const b = mk();
    expect(b.run('Get-ADUser ghost')).toEqual({ output: "Get-ADUser : Cannot find an object with identity: 'ghost' under: 'DC=corp,DC=example'.\n", code: 1 });
    expect(b.run('Get-ADUsr x').output).toBe("Get-ADUsr : The term 'Get-ADUsr' is not recognized as the name of a cmdlet, function, script file, or operable program.\n");
    expect(b.run('Get-ADUser -Nope x').output).toBe("Get-ADUser : A parameter cannot be found that matches parameter name 'Nope'.\n");
    expect(b.run('Get-ADUser').output).toMatch(/Provide -Identity, or -Filter/);
    expect(b.run("Get-ADUser -Filter * -SearchBase 'OU=Nope,DC=corp,DC=example'").output).toBe('Get-ADUser : Directory object not found\n');
    expect(b.run('Set-ADUser mlopez -Enabled maybe').output).toMatch(/Cannot convert value "maybe" to type "System.Boolean"/);
    expect(b.run('Get-ADUser a b').output).toMatch(/positional parameter cannot be found/);
    expect(b.run('Search-ADAccount').output).toMatch(/exactly one of/);
    expect(b.run('Get-ADUser -Filter *; whoami').output.endsWith('corp\\adm.analyst\n')).toBe(true);
    expect(b.run('Get-ADUser ghost; whoami')).toMatchObject({ code: 1 });
  });
  it('abbreviated parameters work when unambiguous', () => {
    const b = mk();
    expect(b.run('Get-ADUser -Id mlopez -Prop Title').output).toMatch(/Title/);
    expect(b.run('Search-ADAccount -Account').output).toMatch(/ambiguous/);
  });
});

describe('changing the directory', () => {
  it('password reset enforces policy, clears must-change, and does not unlock', () => {
    const b = mk();
    const u = b.dir.findUser('mlopez')!;
    u.lockedOut = true;
    expect(b.run("Set-ADAccountPassword mlopez -Reset -NewPassword 'short'").output).toMatch(/does not meet the length, complexity/);
    expect(b.run("Set-ADAccountPassword mlopez -Reset -NewPassword 'alllowercaseletters'").output).toMatch(/does not meet/);
    expect(b.run("Set-ADAccountPassword mlopez -NewPassword 'Tulip-Harbor-2026!'").output).toMatch(/add -Reset/);
    expect(b.run('Set-ADAccountPassword mlopez -Reset').output).toMatch(/-NewPassword is required/);
    expect(u.pwdResets).toBe(0);
    b.run('Set-ADUser mlopez -ChangePasswordAtLogon $true');
    expect(b.out('Get-ADUser mlopez -Properties PasswordExpired,PasswordLastSet')).toMatch(/PasswordExpired +: True\nPasswordLastSet +: \n/);
    expect(b.run("Set-ADAccountPassword mlopez -Reset -NewPassword (ConvertTo-SecureString 'Tulip-Harbor-2026!' -AsPlainText -Force)")).toEqual({ output: '', code: 0 });
    expect([u.pwdResets, u.mustChange, u.lockedOut, u.pwdLastSet]).toEqual([1, false, true, NOW]);
    expect(b.out('Get-ADUser mlopez -Properties PasswordLastSet')).toMatch(/PasswordLastSet +: 11\/23\/2026 9:00:00 AM/);
    b.run('Search-ADAccount -LockedOut | Unlock-ADAccount');
    expect(u.lockedOut).toBe(false);
    expect(b.run('Set-ADUser svc_backup -ChangePasswordAtLogon $true').output).toMatch(/password never expires/);
  });
  it('enable / disable, directly and from the pipeline', () => {
    const b = mk();
    b.run('Disable-ADAccount tjones; Enable-ADAccount jdoe; Set-ADUser bwong -Enabled $false -Description "on leave"');
    expect(['tjones', 'jdoe', 'bwong'].map((s) => b.dir.findUser(s)!.enabled)).toEqual([false, true, false]);
    expect(b.dir.findUser('bwong')!.description).toBe('on leave');
    b.run("Get-ADUser -Filter 'Department -eq \"Sales\"' | Disable-ADAccount");
    expect(b.dir.users.filter((u) => u.department === 'Sales').every((u) => !u.enabled)).toBe(true);
    expect(b.run('Disable-ADAccount').output).toMatch(/Missing mandatory parameter: Identity/);
    b.run('Disable-ADAccount WS-001');
    expect(b.dir.findComputer('WS-001')!.enabled).toBe(false);
    expect(b.run('Unlock-ADAccount WS-001').output).toMatch(/not a user account/);
  });
  it('group membership', () => {
    const b = mk();
    expect(b.run('Add-ADGroupMember Helpdesk -Members tjones,bwong')).toEqual({ output: '', code: 0 });
    expect(b.dir.findGroup('Helpdesk')!.members).toEqual(['omartin', 'kchen', 'tjones', 'bwong']);
    expect(b.run('Add-ADGroupMember Helpdesk tjones').output).toMatch(/already a member/);
    expect(b.run('Remove-ADGroupMember Helpdesk -Members TJONES -Confirm:$false')).toEqual({ output: '', code: 0 });
    expect(b.run('Remove-ADGroupMember Helpdesk tjones').output).toMatch(/not a member/);
    expect(b.run('Remove-ADGroupMember Nope tjones').output).toMatch(/Cannot find an object with identity: 'Nope'/);
    expect(b.run('Add-ADGroupMember Helpdesk -Members ghost').output).toMatch(/identity: 'ghost'/);
    expect(b.run('Add-ADGroupMember Helpdesk').output).toMatch(/Missing mandatory parameter: Members/);
    b.run("Add-ADGroupMember Helpdesk -Members 'Finance-Staff'");
    expect(b.out('Get-ADGroupMember Helpdesk | Select-Object name,objectClass')).toContain('Finance-Staff group');
  });
  it('OUs and moves', () => {
    const b = mk();
    expect(b.run('New-ADOrganizationalUnit -Name Workstations')).toEqual({ output: '', code: 0 });
    expect(b.run('New-ADOrganizationalUnit Workstations').output).toMatch(/name that is already in use/);
    expect(b.run("New-ADOrganizationalUnit Laptops -Path 'OU=Nope,DC=corp,DC=example'").output).toMatch(/Directory object not found/);
    b.run(`New-ADOrganizationalUnit Laptops -Path '${WS_OU}'`);
    expect(b.run(`Move-ADObject WS-001 -TargetPath '${WS_OU}'`).output).toMatch(/Cannot find an object with identity: 'WS-001'/);
    b.run(`Move-ADObject 'cn=ws-001, cn=computers, dc=corp, dc=example' -TargetPath 'OU=Laptops,${WS_OU}'`);
    b.run(`Get-ADComputer WS-002 | Move-ADObject -TargetPath '${WS_OU}'`);
    expect(b.out('Get-ADComputer WS-001 | Select-Object -ExpandProperty DistinguishedName')).toBe(`CN=WS-001,OU=Laptops,${WS_OU}\n`);
    // moving an OU carries its contents along
    b.run(`Move-ADObject '${WS_OU}' -TargetPath 'OU=IT,${DOMAIN_DN}'`);
    expect(b.out('Get-ADComputer WS-001 | Select-Object -ExpandProperty DistinguishedName')).toBe(`CN=WS-001,OU=Laptops,OU=Workstations,OU=IT,${DOMAIN_DN}\n`);
    expect(b.dir.dn(b.dir.findComputer('WS-002')!)).toBe(`CN=WS-002,OU=Workstations,OU=IT,${DOMAIN_DN}`);
    expect(b.run(`Move-ADObject 'OU=IT,${DOMAIN_DN}' -TargetPath 'OU=Workstations,OU=IT,${DOMAIN_DN}'`).code).toBe(1);
    expect(b.run(`Move-ADObject 'CN=WS-003,CN=Computers,${DOMAIN_DN}' -TargetPath 'OU=Nope,${DOMAIN_DN}'`).output).toMatch(/Directory object not found/);
    expect(b.run('Move-ADObject -TargetPath x').output).toMatch(/Missing mandatory parameter: Identity/);
  });
  it('Group Policy links', () => {
    const b = mk();
    b.run('New-ADOrganizationalUnit Workstations');
    expect(b.out('Get-GPO -All | Select-Object -ExpandProperty DisplayName')).toBe('Default Domain Policy\nDefault Domain Controllers Policy\nWorkstation Baseline\nLegacy Kiosk Mode\n');
    expect(b.out(`Get-GPInheritance '${WS_OU}'`)).toMatch(/GpoLinks +: \{\}\nInheritedGpoLinks +: \{Default Domain Policy\}/);
    const linked = b.run(`New-GPLink -Name 'Workstation Baseline' -Target '${WS_OU}'`);
    expect(linked.code).toBe(0);
    expect(linked.output).toMatch(/DisplayName : Workstation Baseline\nEnabled +: True\nEnforced +: False/);
    expect(b.out(`Get-GPInheritance '${WS_OU}'`)).toMatch(/GpoLinks +: \{Workstation Baseline\}\nInheritedGpoLinks +: \{Workstation Baseline, Default Domain Policy\}/);
    expect(b.run(`New-GPLink -Name 'Workstation Baseline' -Target '${WS_OU}'`).output).toMatch(/already linked/);
    expect(b.run(`New-GPLink -Name Nope -Target '${WS_OU}'`).output).toMatch(/GPO with the name 'Nope' was not found/);
    expect(b.run(`New-GPLink -Name 'Workstation Baseline' -Target 'CN=Computers,${DOMAIN_DN}'`).output).toMatch(/container, not an organizational unit/);
    expect(b.run(`New-GPLink -Name 'Workstation Baseline' -Target 'OU=Nope,${DOMAIN_DN}'`).output).toMatch(/no such object/);
    expect(b.run(`New-GPLink -Name 'Workstation Baseline' -Target '${WS_OU}' -Enforced Maybe`).output).toMatch(/Yes, No/);
    b.run(`Set-GPLink 'Workstation Baseline' -Target '${WS_OU}' -LinkEnabled No`);
    expect(b.dir.linksOf(WS_OU)).toEqual([{ gpo: 'Workstation Baseline', enabled: false, enforced: false }]);
    b.run(`Remove-GPLink 'Workstation Baseline' -Target '${WS_OU}'`);
    expect(b.dir.linksOf(WS_OU)).toEqual([]);
    expect(b.out("Get-GPOReport 'Workstation Baseline'")).toContain('  - Screen lock after 10 minutes idle');
    expect(b.out("New-GPO -Name 'Test Policy' | Select-Object DisplayName")).toContain('Test Policy');
    expect(b.run("New-GPO 'Test Policy'").output).toMatch(/already exists/);
  });
  it('Search-ADAccount modes', () => {
    const b = mk();
    const names = (cmd: string): string => b.out(`${cmd} | Select-Object -ExpandProperty SamAccountName`).trim().split('\n').join(',');
    expect(names('Search-ADAccount -AccountDisabled')).toBe('jdoe');
    expect(names('Search-ADAccount -AccountInactive -TimeSpan 90 -UsersOnly')).toBe('rpatel,jdoe');
    expect(names('Search-ADAccount -AccountInactive -TimeSpan 30 -UsersOnly')).toBe('Administrator,rpatel,jdoe');
    expect(names('Search-ADAccount -PasswordNeverExpires')).toBe('svc_backup');
    expect(names('Search-ADAccount -LockedOut')).toBe('');
    expect(b.out('Search-ADAccount -AccountInactive -ComputersOnly')).toBe('');
  });
  it('help, aliases and misc', () => {
    const b = mk();
    expect(b.out('help')).toContain('Get-ADUser');
    expect(b.out('Get-Help New-GPLink')).toMatch(/NAME\n {4}New-GPLink\n\nSYNOPSIS/);
    expect(b.out('man unlock-adaccount')).toContain('Unlock-ADAccount');
    expect(b.run('Get-Help Nope').code).toBe(1);
    expect([b.out('whoami'), b.out('hostname'), b.out('Get-Date')]).toEqual(['corp\\adm.analyst\n', 'MGMT01\n', '11/23/2026 9:00:00 AM\n']);
    expect(b.out('Get-ADDefaultDomainPasswordPolicy')).toMatch(/MinPasswordLength +: 12/);
    expect(b.out('cls')).toBe('');
    expect(b.out('history').trim().split('\n').length).toBeGreaterThan(5);
    b.run('submit some answer');
    expect(b.sh.state.submitted).toEqual(['some answer']);
    expect(b.run('hint').output).toMatch(/Only available inside the game/);
  });
  it('the baseline directory is internally consistent', () => {
    const d: Directory = baseDirectory(NOW);
    for (const o of d.all()) expect(d.isContainer(o.parent), d.dn(o)).toBe(true);
    for (const g of d.groups) for (const m of g.members) expect(d.findUser(m) ?? d.findGroup(m) ?? d.findComputer(m), `${g.name}: ${m}`).toBeDefined();
    for (const dn of [DOMAIN_DN, ...d.ous.filter((o) => !o.container).map((o) => d.dn(o))]) for (const l of d.linksOf(dn)!) expect(d.findGpo(l.gpo)).toBeDefined();
    expect(new Set(d.all().map((o) => d.dn(o).toLowerCase())).size).toBe(d.all().length);
  });
});

describe('AD session', () => {
  it('prompt, scoring and meta commands', () => {
    const g = createSession(AD_LEVELS[1], { hint: () => 'hinted\n' });
    expect(g.prompt().length).toBe('PS C:\\Users\\adm.analyst> '.length);
    for (const c of ['help', 'Get-Help Get-ADUser', 'cls', 'history', 'hint']) g.exec(c);
    expect(g.commandCount).toBe(0);
    expect(g.exec('hint').output).toBe('hinted\n');
    g.exec("Get-ADGroupMember 'Domain Admins'");
    expect(g.commandCount).toBe(1);
  });
  it('fail state: removing an approved admin', () => {
    const g = createSession(AD_LEVELS[1]);
    const r = g.exec("Remove-ADGroupMember 'Domain Admins' -Members adm.kchen");
    expect(r.justFailed).toBe(true);
    expect(g.failMessage).toMatch(/adm\.kchen/);
    g.reset();
    expect(g.exec("Remove-ADGroupMember 'Domain Admins' tjones").justWon).toBe(true);
  });
  it('tab completion: cmdlets, parameters and directory objects', () => {
    const g = createSession(AD_LEVELS[0]);
    const c = (line: string) => g.complete(line, line.length);
    expect(c('get-adus').line).toBe('Get-ADUser ');
    expect(c('Unl').line).toBe('Unlock-ADAccount ');
    expect(c('Get-AD').candidates).toEqual(expect.arrayContaining(['Get-ADUser', 'Get-ADGroup', 'Get-ADComputer']));
    expect(c('Get-ADUser -Pr').line).toBe('Get-ADUser -Properties ');
    expect(c('Set-ADUser ml').line).toBe('Set-ADUser mlopez ');
    expect(c('Get-ADUser -Filter * | sel').line).toBe('Get-ADUser -Filter * | Select-Object ');
    expect(c("Get-ADGroupMember 'Dom").candidates).toEqual(["'Domain Admins'", "'Domain Users'"]);
    expect(c("New-GPLink 'Work").line).toBe("New-GPLink 'Workstation Baseline' ");
    expect(c('Get-Help new-gpl').line).toBe('Get-Help New-GPLink ');
    expect(c('zzz')).toMatchObject({ line: 'zzz', candidates: [] });
  });
});
