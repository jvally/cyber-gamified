import { at, baseFiles, baseProcs, DAY, file, text } from './builders';
import { b64encode } from '../crypto/base64';
import { lastAnswer } from './engine';
import type { Level } from './types';

const NOW = at('2026-11-21T09:00:00Z');
const HOST = 'c2.update-cdn.example';
const ENDPOINT = `https://${HOST}/beacon`; // 36 bytes: encodes without '=' padding
const ENDPOINT_B64 = b64encode(ENDPOINT);
const BANNER_B64 = b64encode('Telemetry Agent v2.4.1');
const CONF = '/opt/telemetry/agent.conf';

/** Accept the bare host name or the full URL, in any letter case. */
const hostOf = (answer: string): string => answer.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:].*$/, '');

export const base64Config: Level = {
  id: 'base64-config',
  module: 'linux',
  title: 'Hidden in Plain Sight',
  story: text(`
    web01 makes an outbound HTTPS request every five minutes.
    The process reads /opt/telemetry/agent.conf, and nobody installed it.
    Some values are base64: an encoding with no key, so anyone can reverse it.
  `),
  objective: 'Decode the endpoint in /opt/telemetry/agent.conf and submit the host name it contacts.',
  now: NOW,
  initialFS: [
    ...baseFiles(NOW),
    file(CONF, text(`
      # telemetry-agent configuration
      [agent]
      name=telemetry-agent
      interval=300
      log_level=warn
      banner_b64=${BANNER_B64}
      endpoint_b64=${ENDPOINT_B64}
    `), { mode: 0o644, mtime: NOW - 3 * DAY }),
    file('/opt/telemetry/VERSION', '2.4.1\n', { mtime: NOW - 3 * DAY }),
  ],
  initialProcesses: [
    ...baseProcs(),
    { pid: 2890, user: 'root', cmd: '/opt/telemetry/agent --config /opt/telemetry/agent.conf', start: '03:25', stat: 'Sl' },
  ],
  goalCheck: (s) => hostOf(lastAnswer(s) ?? '') === HOST,
  hints: [
    'Values made only of A-Z, a-z, 0-9, + and / (often ending in =) are probably base64.',
    '`base64 -d` decodes standard input. Feed it only the value: `echo VALUE | base64 -d`, or cut it out with `cut -d= -f2-`.',
    `\`grep endpoint_b64 ${CONF} | cut -d= -f2- | base64 -d\`, then submit the host name from the URL.`,
  ],
  conceptCard: {
    attack: [
      'Malware encodes its command-and-control address so string searches miss it.',
      'Base64 is free to apply and is often layered with XOR or compression.',
    ],
    detection: [
      'Spot the alphabet: A-Za-z0-9+/ with = padding, length a multiple of four.',
      'Decode it: a URL, shell command or script is a strong signal.',
      'Network side: small outbound requests at a fixed interval (beaconing).',
    ],
    mitigation: [
      'Block the host at DNS and the egress firewall; search other hosts for it.',
      'Remove the implant and its persistence.',
      'Default-deny outbound traffic from servers.',
    ],
    commands: [
      { cmd: `cat ${CONF}`, explain: 'spot which values look encoded' },
      { cmd: 'cut -d= -f2-', explain: 'keep everything after the first "="; the trailing "-" keeps base64 padding' },
      { cmd: 'base64 -d', explain: 'decode base64 from standard input or a file' },
      { cmd: `echo ${ENDPOINT_B64} | base64 -d`, explain: 'quick way for a value you can paste' },
    ],
  },
  intel: 'Command-and-control host identified and blocked. Server room secured.',
  idealSolution: [`cat ${CONF}`, `grep endpoint_b64 ${CONF} | cut -d= -f2- | base64 -d`, `submit ${HOST}`],
  altSolutions: [
    [`echo ${ENDPOINT_B64} | base64 -d`, `submit ${ENDPOINT}`],
    ['cd /opt/telemetry', 'tail -n 1 agent.conf | cut -c14- > /tmp/blob', 'base64 -d /tmp/blob', `submit ${HOST.toUpperCase()}`],
  ],
  wrongSolutions: [
    [`grep banner_b64 ${CONF} | cut -d= -f2- | base64 -d`, 'submit Telemetry Agent v2.4.1'],
    [`submit ${ENDPOINT_B64}`],
    ['submit telemetry-agent'],
  ],
};
