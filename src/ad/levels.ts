// Active Directory module: five defensive administration tasks on the simulated corp.example domain.
import { at } from '../levels/builders';
import { AdUser, DOMAIN_DN, sameDn } from './directory';
import type { AdLevel, AdState } from './types';

const NOW = at('2026-11-23T09:00:00Z');
const WS = ['WS-001', 'WS-002', 'WS-003'];
const WS_OU = `OU=Workstations,${DOMAIN_DN}`;
const user = (s: AdState, sam: string): AdUser => s.dir.findUser(sam)!;

const accountRecovery: AdLevel = {
  id: 'ad-account-recovery',
  module: 'ad',
  title: 'Phished and Locked Out',
  story: [
    'Maria Lopez (mlopez) typed her password into a phishing page, then got locked out by failed logons.',
    'The attacker knows her current password.',
    'You are a domain admin on MGMT01.',
  ].join('\n'),
  objective: 'Secure mlopez: reset the password, require a change at next logon, and unlock the account.',
  now: NOW,
  setup: (d) => { const u = d.findUser('mlopez')!; u.lockedOut = true; u.lastLogon = NOW - 7200; },
  goalCheck: (s) => { const u = user(s, 'mlopez'); return u.pwdResets >= 1 && u.mustChange && !u.lockedOut && u.enabled; },
  hints: [
    '`Get-ADUser mlopez -Properties LockedOut,PasswordLastSet` shows the account state. Three things need changing.',
    'Reset with `Set-ADAccountPassword -Reset`, then `Set-ADUser -ChangePasswordAtLogon $true`, then `Unlock-ADAccount`. A reset clears the must-change flag, so reset first.',
    "In order: `Set-ADAccountPassword mlopez -Reset -NewPassword 'Tulip-Harbor-2026!'`, `Set-ADUser mlopez -ChangePasswordAtLogon $true`, `Unlock-ADAccount mlopez`.",
  ],
  conceptCard: {
    attack: [
      'A phished password stays valid until it is changed.',
      'Lockout only slows guessing. It does not help once the real password is known.',
    ],
    detection: [
      'Search-ADAccount -LockedOut lists locked accounts.',
      'Logons from unfamiliar locations right after a phishing report.',
    ],
    mitigation: [
      'Reset the password, force a change at next logon, then unlock.',
      'Reset first: a reset stamps the password as new and clears the must-change flag.',
      'Revoke active sessions and enrol the user in MFA.',
    ],
    commands: [
      { cmd: 'Get-ADUser mlopez -Properties LockedOut,PasswordLastSet', explain: 'extra properties must be requested by name' },
      { cmd: "Set-ADAccountPassword mlopez -Reset -NewPassword (ConvertTo-SecureString 'Tulip-Harbor-2026!' -AsPlainText -Force)", explain: 'admin reset; the password must meet domain policy' },
      { cmd: 'Set-ADUser mlopez -ChangePasswordAtLogon $true', explain: 'the temporary password is only good for one logon' },
      { cmd: 'Unlock-ADAccount mlopez', explain: 'clear the lockout so the user can sign in' },
    ],
  },
  intel: "The phishing mail was sent from tjones's mailbox. Check what that account has access to.",
  idealSolution: [
    "Set-ADAccountPassword mlopez -Reset -NewPassword (ConvertTo-SecureString 'Tulip-Harbor-2026!' -AsPlainText -Force)",
    'Set-ADUser mlopez -ChangePasswordAtLogon $true',
    'Unlock-ADAccount mlopez',
  ],
  altSolutions: [
    [
      'Get-ADUser mlopez -Properties LockedOut,PasswordLastSet',
      "Set-ADAccountPassword -Identity mlopez -Reset -NewPassword 'Tulip-Harbor-2026!'",
      'Unlock-ADAccount -Identity mlopez',
      'Set-ADUser -Identity mlopez -ChangePasswordAtLogon $true',
    ],
    [
      'Search-ADAccount -LockedOut | Unlock-ADAccount',
      "Get-ADUser mlopez | Set-ADAccountPassword -Reset -NewPassword (ConvertTo-SecureString 'Correct-Horse-9!' -AsPlainText -Force)",
      'Get-ADUser mlopez | Set-ADUser -ChangePasswordAtLogon $true',
    ],
  ],
  wrongSolutions: [
    ['Unlock-ADAccount mlopez'], // the attacker still has the password
    // flag set before the reset: the reset clears it again
    ['Set-ADUser mlopez -ChangePasswordAtLogon $true', "Set-ADAccountPassword mlopez -Reset -NewPassword 'Tulip-Harbor-2026!'", 'Unlock-ADAccount mlopez'],
    // too short for the domain policy, so the reset is rejected
    ["Set-ADAccountPassword mlopez -Reset -NewPassword 'Winter1'", 'Set-ADUser mlopez -ChangePasswordAtLogon $true', 'Unlock-ADAccount mlopez'],
    ['Disable-ADAccount mlopez'],
  ],
};

const APPROVED_ADMINS = ['administrator', 'adm.kchen'];
const domainAdmins: AdLevel = {
  id: 'ad-domain-admins',
  module: 'ad',
  title: 'Too Many Keys to the Kingdom',
  story: [
    'The phish came from tjones, a sales intern. Check what that account can do.',
    'Domain Admins control every account and computer in the domain.',
    'Approved members: Administrator and adm.kchen.',
  ].join('\n'),
  objective: 'Remove the account that should not be in Domain Admins.',
  now: NOW,
  setup: (d) => { d.findGroup('Domain Admins')!.members.push('tjones'); },
  goalCheck: (s) => {
    const m = s.dir.findGroup('Domain Admins')!.members.map((x) => x.toLowerCase()).sort();
    return m.join() === [...APPROVED_ADMINS].sort().join();
  },
  failCheck: (s) => {
    const m = s.dir.findGroup('Domain Admins')!.members.map((x) => x.toLowerCase());
    const gone = APPROVED_ADMINS.find((a) => !m.includes(a));
    return gone ? `You removed ${gone} from Domain Admins. Approved admins must keep their access.` : null;
  },
  hints: [
    '`Get-ADGroupMember` lists the members of a group. Compare the result with the approved list.',
    "`Get-ADGroupMember 'Domain Admins'` shows three members; one is a sales intern. `Remove-ADGroupMember` takes -Identity (the group) and -Members.",
    "`Remove-ADGroupMember 'Domain Admins' -Members tjones -Confirm:$false`.",
  ],
  conceptCard: {
    attack: [
      'A Domain Admin can read every mailbox, reset every password and push software to every machine.',
      'Rights added "temporarily" are rarely removed, so ordinary accounts end up with full control.',
    ],
    detection: [
      'Review privileged groups regularly: Get-ADGroupMember on Domain Admins, Enterprise Admins.',
      'Alert on membership changes (event ID 4728).',
    ],
    mitigation: [
      'Least privilege: keep Domain Admins tiny and use separate admin accounts.',
      'Delegate specific rights (such as password resets) to a group instead.',
      'Remove membership as soon as a task is finished.',
    ],
    commands: [
      { cmd: "Get-ADGroupMember 'Domain Admins'", explain: 'who holds domain-wide control right now' },
      { cmd: 'Get-ADUser tjones -Properties MemberOf,Title', explain: 'the same question from the user side' },
      { cmd: "Remove-ADGroupMember 'Domain Admins' -Members tjones -Confirm:$false", explain: 'take the right away; the account itself is untouched' },
    ],
  },
  intel: 'An audit of the other groups shows more leftovers: an account nobody has used for months is still enabled.',
  idealSolution: ["Get-ADGroupMember 'Domain Admins'", "Remove-ADGroupMember 'Domain Admins' -Members tjones -Confirm:$false"],
  altSolutions: [
    ["Get-ADGroup 'Domain Admins' -Properties Members", 'Remove-ADGroupMember -Identity "Domain Admins" -Members tjones'],
    ['Get-ADUser tjones -Properties MemberOf,Title', "Remove-ADGroupMember 'Domain Admins' tjones"],
  ],
  wrongSolutions: [
    ['Disable-ADAccount tjones'], // still a member the moment the account is re-enabled
    ["Remove-ADGroupMember 'Domain Admins' -Members tjones,adm.kchen"],
    ["Remove-ADGroupMember 'Sales-Staff' -Members tjones"],
  ],
};

const staleAccount: AdLevel = {
  id: 'ad-stale-account',
  module: 'ad',
  title: 'The Account Nobody Uses',
  story: [
    'Unused accounts are easy targets: nobody notices when they log on.',
    'Policy: user accounts inactive for 90 days are disabled, not deleted.',
    'One enabled account breaks that rule.',
  ].join('\n'),
  objective: 'Disable the enabled user account that has been inactive for more than 90 days.',
  now: NOW,
  setup: () => { /* rpatel is stale in the baseline directory */ },
  goalCheck: (s) => !user(s, 'rpatel').enabled,
  failCheck: (s) => {
    const hit = s.dir.users.find((u) => !u.enabled && u.sam !== 'rpatel' && u.sam !== 'jdoe');
    return hit ? `You disabled ${hit.sam}, an account in active use.` : null;
  },
  hints: [
    '`Search-ADAccount -AccountInactive -TimeSpan 90 -UsersOnly` lists user accounts with no logon in 90 days.',
    'Two accounts match, but one is already disabled. Add `| Select-Object Name,Enabled,LastLogonDate` to see which.',
    '`Disable-ADAccount rpatel`.',
  ],
  conceptCard: {
    attack: [
      'Accounts of people who left keep their password, group memberships and VPN access.',
      'Nobody is watching them, so a takeover goes unnoticed.',
    ],
    detection: [
      'Search-ADAccount -AccountInactive -TimeSpan 90 finds accounts with no recent logon.',
      'Or sort all users by LastLogonDate (request it with -Properties).',
    ],
    mitigation: [
      'Disable on the last working day, driven by HR offboarding.',
      'Disable first and delete after a retention period: disabling is reversible.',
      'Run the inactivity search on a schedule.',
    ],
    commands: [
      { cmd: 'Search-ADAccount -AccountInactive -TimeSpan 90 -UsersOnly', explain: 'accounts with no logon in the last 90 days' },
      { cmd: 'Select-Object Name,Enabled,LastLogonDate', explain: 'cut the output down to the columns that matter' },
      { cmd: 'Disable-ADAccount rpatel', explain: 'block logon; memberships and data are kept' },
    ],
  },
  intel: "rpatel's last logon came from WS-002. The workstations sit in the default Computers container, unmanaged.",
  idealSolution: ['Search-ADAccount -AccountInactive -TimeSpan 90 -UsersOnly | Select-Object Name,Enabled,LastLogonDate', 'Disable-ADAccount rpatel'],
  altSolutions: [
    ['Get-ADUser -Filter * -Properties LastLogonDate | Sort-Object LastLogonDate | Select-Object SamAccountName,Enabled,LastLogonDate', 'Set-ADUser rpatel -Enabled $false'],
    ['Search-ADAccount -AccountInactive -TimeSpan 90 -UsersOnly | Disable-ADAccount'],
  ],
  wrongSolutions: [
    ['Disable-ADAccount jdoe'], // already disabled
    ['Get-ADUser -Filter * | Disable-ADAccount'], // disables everyone
    ['Unlock-ADAccount rpatel'],
  ],
};

const SERVERS: Record<string, string> = { 'SRV-DC01': `OU=Domain Controllers,${DOMAIN_DN}`, 'SRV-FILE01': `OU=Servers,${DOMAIN_DN}` };
const ouStructure: AdLevel = {
  id: 'ad-ou-structure',
  module: 'ad',
  title: 'A Place for Everything',
  story: [
    'WS-001, WS-002 and WS-003 sit in CN=Computers, the default container.',
    'A container is not an OU: Group Policy cannot be linked to it, so these machines get no workstation policy.',
    'Servers must stay where they are.',
  ].join('\n'),
  objective: 'Create an OU named Workstations at the domain root and move the three WS computers into it.',
  now: NOW,
  setup: () => { /* workstations start in CN=Computers */ },
  goalCheck: (s) => {
    const ou = s.dir.findOU(WS_OU);
    return !!ou && !ou.container && WS.every((n) => sameDn(s.dir.findComputer(n)!.parent, WS_OU));
  },
  failCheck: (s) => {
    const moved = Object.entries(SERVERS).find(([n, parent]) => !sameDn(s.dir.findComputer(n)!.parent, parent));
    return moved ? `You moved ${moved[0]}. Servers and domain controllers need their own policies.` : null;
  },
  hints: [
    '`Get-ADComputer -Filter * | Select-Object Name,DistinguishedName` shows where each computer lives.',
    '`New-ADOrganizationalUnit -Name <name>` creates an OU. `Move-ADObject` needs a distinguished name, or objects piped from `Get-ADComputer`.',
    "`New-ADOrganizationalUnit -Name Workstations`, then `Get-ADComputer -Filter 'Name -like \"WS-*\"' | Move-ADObject -TargetPath 'OU=Workstations,DC=corp,DC=example'`.",
  ],
  conceptCard: {
    attack: [
      'Computers joined to the domain land in CN=Computers and receive only domain-wide policy.',
      'Unmanaged workstations miss screen lock, firewall and USB rules: easy first footholds.',
    ],
    detection: [
      'Get-ADComputer -Filter * -SearchBase "CN=Computers,..." should return nothing.',
      'Get-ADOrganizationalUnit lists OUs; built-in containers do not appear.',
    ],
    mitigation: [
      'Design OUs around how policy is applied: workstations, servers, privileged systems.',
      'Redirect new computer accounts to a managed OU (redircmp).',
      'Never mix servers and workstations under one policy.',
    ],
    commands: [
      { cmd: 'Get-ADComputer -Filter * | Select-Object Name,DistinguishedName', explain: 'the DN shows which container each computer is in' },
      { cmd: 'New-ADOrganizationalUnit -Name Workstations', explain: 'created at the domain root unless -Path is given' },
      { cmd: "Get-ADComputer -Filter 'Name -like \"WS-*\"' | Move-ADObject -TargetPath 'OU=Workstations,DC=corp,DC=example'", explain: 'filter, then move everything that matched' },
    ],
  },
  intel: 'The Workstations OU exists, but no policy is linked to it: no screen lock, USB storage open.',
  idealSolution: [
    'New-ADOrganizationalUnit -Name Workstations',
    `Get-ADComputer -Filter 'Name -like "WS-*"' | Move-ADObject -TargetPath '${WS_OU}'`,
  ],
  altSolutions: [
    [
      'Get-ADComputer -Filter * | Select-Object Name,DistinguishedName',
      `New-ADOrganizationalUnit Workstations -Path '${DOMAIN_DN}'`,
      ...WS.map((n) => `Move-ADObject 'CN=${n},CN=Computers,${DOMAIN_DN}' -TargetPath '${WS_OU}'`),
    ],
    ['New-ADOrganizationalUnit -Name Workstations', `Get-ADComputer -Filter * -SearchBase 'CN=Computers,${DOMAIN_DN}' | Move-ADObject -TargetPath '${WS_OU}'`],
  ],
  wrongSolutions: [
    ['New-ADOrganizationalUnit -Name Workstations'], // OU created, nothing moved
    ['New-ADOrganizationalUnit -Name Workstations', `Get-ADComputer -Filter * | Move-ADObject -TargetPath '${WS_OU}'`], // servers too
    [`New-ADOrganizationalUnit -Name Workstations -Path 'OU=IT,${DOMAIN_DN}'`, `Get-ADComputer -Filter 'Name -like "WS-*"' | Move-ADObject -TargetPath 'OU=Workstations,OU=IT,${DOMAIN_DN}'`],
    [`Move-ADObject WS-001 -TargetPath '${WS_OU}'`],
  ],
};

const BASELINE = 'Workstation Baseline';
const gpoLink: AdLevel = {
  id: 'ad-gpo-link',
  module: 'ad',
  title: 'Policy Without a Link',
  story: [
    'The Workstations OU receives no workstation policy: no screen lock, removable storage open.',
    'A GPO does nothing until it is linked, and a link applies to everything under its target.',
    `A reviewed GPO named "${BASELINE}" already exists.`,
  ].join('\n'),
  objective: `Link the "${BASELINE}" GPO to the Workstations OU.`,
  now: NOW,
  setup: (d) => {
    d.ou('Workstations');
    for (const n of WS) d.findComputer(n)!.parent = WS_OU;
  },
  goalCheck: (s) => !!s.dir.linksOf(WS_OU)?.some((l) => l.gpo === BASELINE && l.enabled),
  failCheck: (s) => {
    const targets: [string, string][] = [[DOMAIN_DN, 'the whole domain'], ...s.dir.ous.filter((o) => !o.container).map((o): [string, string] => [s.dir.dn(o), o.name])];
    for (const [dn, label] of targets) {
      for (const l of s.dir.linksOf(dn) ?? []) {
        if (l.gpo === 'Legacy Kiosk Mode') return `You linked Legacy Kiosk Mode to ${label}. That GPO replaces the desktop with a kiosk browser.`;
        if (l.gpo === BASELINE && !sameDn(dn, WS_OU)) return `You linked ${BASELINE} to ${label}. Its settings now apply to machines it was never tested on.`;
      }
    }
    return null;
  },
  hints: [
    '`Get-GPO -All | Select-Object DisplayName,Description` lists the GPOs. `Get-GPInheritance` shows what an OU receives now.',
    '`New-GPLink` takes the GPO name and a -Target distinguished name. Target the OU, not the domain, or servers get the policy too.',
    "`New-GPLink -Name 'Workstation Baseline' -Target 'OU=Workstations,DC=corp,DC=example'`.",
  ],
  conceptCard: {
    attack: [
      'Without enforced policy each workstation is configured by hand, or not at all.',
      'One unlocked screen or one infected USB stick is enough for a foothold.',
    ],
    detection: [
      'Get-GPInheritance -Target <OU> lists linked and inherited GPOs.',
      'An OU with computers but only domain-level GPOs is a gap.',
    ],
    mitigation: [
      'Link a tested baseline GPO to the OU that holds the machines.',
      'Link as low in the tree as possible: a domain-level link hits servers and DCs.',
      'Review a GPO before linking it (Get-GPOReport) and pilot on a small OU.',
    ],
    commands: [
      { cmd: 'Get-GPO -All | Select-Object DisplayName,Description', explain: 'which GPOs exist' },
      { cmd: "Get-GPInheritance -Target 'OU=Workstations,DC=corp,DC=example'", explain: 'which GPOs reach this OU today' },
      { cmd: `Get-GPOReport '${BASELINE}'`, explain: 'what the GPO configures, before applying it' },
      { cmd: `New-GPLink -Name '${BASELINE}' -Target 'OU=Workstations,DC=corp,DC=example'`, explain: 'apply the GPO to everything in the OU' },
    ],
  },
  intel: 'Directory hardened: accounts, admin rights, OU structure and policy are under control.',
  idealSolution: ['Get-GPO -All | Select-Object DisplayName,Description', `New-GPLink -Name '${BASELINE}' -Target '${WS_OU}'`],
  altSolutions: [
    [`Get-GPInheritance -Target '${WS_OU}'`, `Get-GPOReport '${BASELINE}'`, `New-GPLink "${BASELINE}" -Target "${WS_OU}" -LinkEnabled Yes -Enforced Yes`],
    [`Get-GPO -Name '${BASELINE}' | New-GPLink -Target '${WS_OU}'`],
  ],
  wrongSolutions: [
    [`New-GPLink -Name '${BASELINE}' -Target '${DOMAIN_DN}'`], // applies to servers and DCs
    [`New-GPLink -Name 'Legacy Kiosk Mode' -Target '${WS_OU}'`],
    [`New-GPLink -Name '${BASELINE}' -Target '${WS_OU}' -LinkEnabled No`], // linked but switched off
    [`New-GPLink -Name '${BASELINE}' -Target 'CN=Computers,${DOMAIN_DN}'`], // containers cannot take links
  ],
};

export const AD_LEVELS: AdLevel[] = [accountRecovery, domainAdmins, staleAccount, ouStructure, gpoLink];
