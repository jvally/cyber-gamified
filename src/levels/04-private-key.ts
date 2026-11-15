import { at, baseFiles, baseProcs, DAY, dir, file, text } from './builders';
import type { Level } from './types';

const NOW = at('2026-11-17T09:00:00Z');
const A = { owner: 'analyst', mtime: NOW - 20 * DAY };
const KEY = '/home/analyst/.ssh/id_ed25519';

export const privateKey: Level = {
  id: 'private-key',
  title: 'Too Many Eyes on the Key',
  story: text(`
    You try to hop from web01 to the database server and SSH refuses to use your key.
    The error is saved in ~/ssh-error.txt. SSH is protecting you here: a private key that
    other accounts on the machine can read is as good as stolen, so the client will not
    touch it until the permissions are fixed.

    web01 is a shared box. Any other local user (or a compromised service account such as
    www-data) could copy the key as it stands.
  `),
  objective: 'Change the permissions of ~/.ssh/id_ed25519 so that only its owner can access it.',
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
    : 'The private key is gone. Without it you cannot log in to db01 at all; tightening permissions never requires deleting the file.'),
  hints: [
    'Look at the key with `ls -l ~/.ssh`. The first column shows three permission groups: owner, group, others. Which of them can read the private key right now?',
    '`chmod` changes permissions. A private key should be readable and writable by its owner and nobody else: rw------- which is 600 in octal (4=read, 2=write, per digit: owner, group, others).',
    'Run `chmod 600 ~/.ssh/id_ed25519` (or the symbolic form `chmod go-rwx ~/.ssh/id_ed25519`).',
  ],
  conceptCard: {
    attack: 'Credential theft through weak file permissions. A private key readable by "group" or "others" can be copied by any local account, including a service account an attacker has taken over through a web bug. With the key they can log in wherever you can, and nothing looks unusual in the logs.',
    detection: 'ls -l shows the mode: anything other than -rw------- (or -r--------) on a private key is a finding. At scale, find / -name "id_*" -perm /077 lists keys that group or others can touch. The SSH client itself refuses to use such a key, which is often how people first notice.',
    mitigation: 'chmod 600 on private keys and 700 on ~/.ssh. Protect keys with a passphrase and an agent, prefer hardware-backed keys, and rotate any key that was exposed: once it could have been copied, tightening permissions does not make it secret again.',
    commands: [
      { cmd: 'ls -l ~/.ssh', explain: 'read the mode string: -rw-r--r-- means owner rw, group r, others r' },
      { cmd: 'chmod 600 ~/.ssh/id_ed25519', explain: 'octal form: 6 = rw for the owner, 0 for group, 0 for others' },
      { cmd: 'chmod go-rwx ~/.ssh/id_ed25519', explain: 'symbolic form: remove every permission from group and others' },
    ],
  },
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
