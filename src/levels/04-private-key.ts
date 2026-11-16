import { at, baseFiles, baseProcs, DAY, dir, file, text } from './builders';
import type { Level } from './types';

const NOW = at('2026-11-17T09:00:00Z');
const A = { owner: 'analyst', mtime: NOW - 20 * DAY };
const KEY = '/home/analyst/.ssh/id_ed25519';

export const privateKey: Level = {
  id: 'private-key',
  module: 'linux',
  title: 'Too Many Eyes on the Key',
  story: text(`
    SSH refuses your key for db01. The error is in ~/ssh-error.txt.
    The key is readable by every account on this shared host, including service accounts such as www-data.
    A readable private key can be copied and used.
  `),
  objective: 'Make ~/.ssh/id_ed25519 accessible only by its owner.',
  now: NOW,
  initialFS: [
    ...baseFiles(NOW),
    file('/home/analyst/ssh-error.txt', text(`
      $ ssh -i ~/.ssh/id_ed25519 deploy@db01
      @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
      @         WARNING: UNPROTECTED PRIVATE KEY FILE!          @
      @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
      Permissions 0644 for '/home/analyst/.ssh/id_ed25519' are too open.
      It is required that your private key files are NOT accessible by others.
      This private key will be ignored.
      Load key "/home/analyst/.ssh/id_ed25519": bad permissions
      deploy@db01: Permission denied (publickey).
    `), { owner: 'analyst', mtime: NOW - 120 }),
    dir('/home/analyst/.ssh', { ...A, mode: 0o700 }),
    file(KEY, text(`
      -----BEGIN OPENSSH PRIVATE KEY-----
      VFJBSU5JTkcgRklYVFVSRSAtIG5vdCBhIHJlYWwga2V5IC0gU2hlbGxTaG9jayBBY2FkZW15
      -----END OPENSSH PRIVATE KEY-----
    `), { ...A, mode: 0o644 }),
    file(`${KEY}.pub`, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFRSQUlOSU5HLUZJWFRVUkUtbm90LWEtcmVhbC1rZXk analyst@web01\n', { ...A, mode: 0o644 }),
    file('/home/analyst/.ssh/known_hosts', 'db01 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEV4YW1wbGVIb3N0S2V5Rm9yVHJhaW5pbmdPbmx5\n', { ...A, mode: 0o644 }),
    file('/home/analyst/.ssh/config', 'Host db01\n  User deploy\n  IdentityFile ~/.ssh/id_ed25519\n', { ...A, mode: 0o600 }),
  ],
  initialProcesses: baseProcs(),
  goalCheck: (s) => {
    const n = s.vfs.tryGet(KEY);
    return !!n && n.type === 'file' && n.owner === 'analyst' && (n.mode & 0o077) === 0 && (n.mode & 0o400) !== 0;
  },
  failCheck: (s) => (s.vfs.tryGet(KEY)?.type === 'file' ? null
    : 'The private key is gone. Fixing permissions never requires deleting the file.'),
  hints: [
    '`ls -l ~/.ssh` shows three permission groups: owner, group, others. Check who can read the key.',
    '`chmod` changes permissions. A private key should be rw------- (600): 4=read, 2=write, one digit each for owner, group, others.',
    '`chmod 600 ~/.ssh/id_ed25519` or `chmod go-rwx ~/.ssh/id_ed25519`.',
  ],
  conceptCard: {
    attack: [
      'A private key readable by group or others can be copied by any local account.',
      'Logins with a stolen key look legitimate in the logs.',
    ],
    detection: [
      'ls -l: anything but -rw------- or -r-------- on a private key is a finding.',
      'At scale: find / -name "id_*" -perm /077.',
      'The SSH client refuses over-permissive keys.',
    ],
    mitigation: [
      'chmod 600 on private keys, 700 on ~/.ssh.',
      'Rotate an exposed key: tightening permissions does not make it secret again.',
      'Add a passphrase; prefer hardware-backed keys.',
    ],
    commands: [
      { cmd: 'ls -l ~/.ssh', explain: '-rw-r--r-- means owner rw, group r, others r' },
      { cmd: 'chmod 600 ~/.ssh/id_ed25519', explain: 'octal: 6 = rw for owner, 0 for group, 0 for others' },
      { cmd: 'chmod go-rwx ~/.ssh/id_ed25519', explain: 'symbolic: remove all access from group and others' },
    ],
  },
  intel: 'Someone has been on this box. Check what is listening on the network.',
  idealSolution: ['ls -l ~/.ssh', 'chmod 600 ~/.ssh/id_ed25519'],
  altSolutions: [
    ['chmod go-rwx ~/.ssh/id_ed25519'],
    ['cd .ssh', 'chmod u=rw,go= id_ed25519', 'ls -l'],
    ['chmod 400 /home/analyst/.ssh/id_ed25519'],
    ['chmod -R go-rwx ~/.ssh'],
  ],
  wrongSolutions: [
    ['chmod 640 ~/.ssh/id_ed25519'],
    ['chmod 000 ~/.ssh/id_ed25519'],
    ['chmod 600 ~/.ssh/id_ed25519.pub'],
    ['chmod o-r ~/.ssh/id_ed25519'],
    ['rm ~/.ssh/id_ed25519'],
  ],
};
