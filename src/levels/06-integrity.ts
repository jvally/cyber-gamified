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
  module: 'linux',
  title: 'Trust, but Verify',
  story: text(`
    Scripts in /usr/local/bin run as root from cron. One changed line there runs with full privileges.
    /opt/baseline/SHA256SUMS holds each script's SHA-256 hash from build day.
    A changed file has a different hash. Timestamps and sizes can be faked.
  `),
  objective: 'Submit the name of the script in /usr/local/bin that no longer matches the baseline.',
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
    '`ls -l` misleads here: the newest file is not the modified one. Compare content hashes with `sha256sum`.',
    '`sha256sum -c LIST` re-hashes every file named in LIST and prints OK or FAILED.',
    '`sha256sum -c /opt/baseline/SHA256SUMS`, then submit the file marked FAILED.',
  ],
  conceptCard: {
    attack: [
      'Editing a script that already runs as root gives persistent privileged execution.',
      'Resetting the modification time ("timestomping") hides the change from ls.',
    ],
    detection: [
      'Record hashes while the system is known good; compare later with sha256sum -c.',
      'One changed byte gives a completely different hash.',
      'AIDE, Tripwire and Wazuh automate this; dpkg --verify checks packaged files.',
    ],
    mitigation: [
      'Restore from a trusted source instead of hand-editing.',
      'Keep the baseline off the host or signed.',
      'Deploy from version control so drift is visible.',
    ],
    commands: [
      { cmd: 'sha256sum -c /opt/baseline/SHA256SUMS', explain: 're-hash each listed file and compare: OK or FAILED' },
      { cmd: 'sha256sum /usr/local/bin/*', explain: 'compute current hashes to compare by hand' },
      { cmd: 'cat now.txt baseline.txt | sort | uniq -u', explain: 'lines that appear once are the ones that differ' },
    ],
  },
  intel: 'healthcheck.sh was modified, and the backdoor is running again. Look for a timer that restarts it.',
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
