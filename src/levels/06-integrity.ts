import { at, baseFiles, baseProcs, DAY, file, text } from './builders';
import { sha256 } from '../crypto/sha256';
import { lastAnswer } from './engine';
import type { Level } from './types';

const NOW = at('2026-11-19T09:00:00Z');
const BIN = '/usr/local/bin';
const TAMPERED = 'healthcheck.sh';

const ORIGINALS: Record<string, string> = {
  'backup.sh': text(`
    #!/bin/sh
    # nightly database backup
    set -eu
    pg_dump shop | gzip > /var/backups/shop-$(date +%F).sql.gz
    find /var/backups -name "shop-*.sql.gz" -mtime +14 -delete
  `),
  'deploy.sh': text(`
    #!/bin/sh
    # pull the tagged release and restart the app
    set -eu
    cd /var/www/shop
    git fetch --tags
    git checkout "$1"
    systemctl reload php8.3-fpm
  `),
  'healthcheck.sh': text(`
    #!/bin/sh
    # called by monitoring every minute
    set -eu
    curl -fsS -o /dev/null http://127.0.0.1/health
    pg_isready -q
    echo OK
  `),
  'rotate-logs.sh': text(`
    #!/bin/sh
    set -eu
    logrotate /etc/logrotate.d/shop
  `),
  'sync-assets.sh': text(`
    #!/bin/sh
    set -eu
    rsync -a --delete /var/www/shop/public/assets/ /srv/cdn/assets/
  `),
};
const MANIFEST = Object.entries(ORIGINALS).map(([n, c]) => `${sha256(c)}  ${BIN}/${n}`).join('\n') + '\n';
// One extra line was slipped in. The attacker reset the timestamp so the file does not look new.
const tamperedContent = ORIGINALS[TAMPERED].replace('echo OK\n', 'cp /etc/passwd /var/tmp/.p 2>/dev/null\necho OK\n');

const mtimes: Record<string, number> = {
  'backup.sh': NOW - 90 * DAY, 'deploy.sh': NOW - 2 * DAY, 'healthcheck.sh': NOW - 90 * DAY,
  'rotate-logs.sh': NOW - 90 * DAY, 'sync-assets.sh': NOW - 61 * DAY,
};

export const integrity: Level = {
  id: 'integrity',
  title: 'Trust, but Verify',
  story: text(`
    After yesterday's backdoor, nobody trusts web01. The operations scripts in
    /usr/local/bin run as root from cron and monitoring, which makes them a perfect hiding
    place: change one line and your code runs with full privileges forever.

    Luckily a baseline exists. On the day the server was built, a SHA-256 checksum of every
    script was recorded in /opt/baseline/SHA256SUMS. A file whose hash no longer matches
    has been modified. Timestamps and sizes can be faked; a cryptographic hash cannot.
  `),
  objective: 'Find the script in /usr/local/bin whose contents no longer match the baseline and submit its file name (submit <name>).',
  now: NOW,
  initialFS: [
    ...baseFiles(NOW),
    ...Object.entries(ORIGINALS).map(([n, c]) =>
      file(`${BIN}/${n}`, n === TAMPERED ? tamperedContent : c, { mode: 0o755, mtime: mtimes[n] })),
    file('/opt/baseline/SHA256SUMS', MANIFEST, { mode: 0o444, mtime: NOW - 90 * DAY }),
    file('/opt/baseline/README', 'Checksums recorded at build time. Verify with: sha256sum -c SHA256SUMS\n', { mode: 0o444, mtime: NOW - 90 * DAY }),
  ],
  initialProcesses: baseProcs(),
  goalCheck: (s) => {
    const a = lastAnswer(s);
    return a === TAMPERED || a === `${BIN}/${TAMPERED}`;
  },
  hints: [
    'Do not trust `ls -l`: the newest file is not the modified one. `sha256sum` computes a fingerprint of a file\'s contents; the baseline file lists the fingerprints the scripts should have.',
    '`sha256sum` has a check mode: give it a checksum list with `-c` and it re-hashes every file named in the list and reports OK or FAILED for each.',
    'Run `sha256sum -c /opt/baseline/SHA256SUMS`, then submit the name of the file marked FAILED.',
  ],
  conceptCard: {
    attack: 'Tampering with trusted files (trojanised scripts or binaries). Instead of adding something new and obvious, an attacker edits a file that already runs with privileges, then resets its modification time ("timestomping") so a directory listing looks normal. The change survives reboots and password resets.',
    detection: 'File integrity monitoring: record cryptographic hashes of important files while the system is known to be good, store them where an attacker cannot rewrite them, and compare later. sha256sum -c does exactly this. Any change to the content, even one byte, produces a completely different hash. Tools such as AIDE, Tripwire and Wazuh automate it; package managers can verify their own files (dpkg --verify, rpm -V).',
    mitigation: 'Restore the file from a trusted source rather than hand-editing it, and investigate how it was changed. Keep baselines off the host or signed, make system directories writable only by root, deploy from version control so drift is visible, and alert on integrity failures instead of checking only after an incident.',
    commands: [
      { cmd: 'sha256sum -c /opt/baseline/SHA256SUMS', explain: 're-hash each listed file and compare with the recorded value: OK or FAILED' },
      { cmd: 'sha256sum /usr/local/bin/*', explain: 'compute current hashes yourself, to compare with the baseline by hand' },
      { cmd: 'cat now.txt baseline.txt | sort | uniq -u', explain: 'lines that appear only once are the ones that differ between two lists' },
    ],
  },
  idealSolution: ['sha256sum -c /opt/baseline/SHA256SUMS', `submit ${TAMPERED}`],
  altSolutions: [
    [
      'sha256sum /usr/local/bin/* > /tmp/now.txt',
      'cat /tmp/now.txt /opt/baseline/SHA256SUMS | sort | uniq -u',
      `submit ${BIN}/${TAMPERED}`,
    ],
    ['cd /usr/local/bin', 'sha256sum healthcheck.sh', 'grep healthcheck /opt/baseline/SHA256SUMS', `submit ${TAMPERED}`],
    ['sha256sum -c /opt/baseline/SHA256SUMS 2>/dev/null | grep -v OK', `submit ${TAMPERED}`],
  ],
  wrongSolutions: [
    ['ls -lt /usr/local/bin', 'submit deploy.sh'], // newest mtime, but unchanged
    ['submit SHA256SUMS'],
  ],
};
