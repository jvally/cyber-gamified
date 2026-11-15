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
  title: 'Hidden in Plain Sight',
  story: text(`
    Last stop. The firewall logs show web01 making a small outbound HTTPS request every five
    minutes. The process responsible calls itself a "telemetry agent" and reads its settings
    from /opt/telemetry/agent.conf, but nobody on the team installed it.

    The config does not say where it connects: some values are a jumble of letters and
    digits. That is base64, a way of writing arbitrary bytes as text. It is used to dodge
    simple keyword searches, not to keep secrets: it has no key, and anyone can reverse it.
  `),
  objective: 'Decode the obfuscated endpoint in /opt/telemetry/agent.conf and submit the host name the agent connects to (submit <host>).',
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
    'Read the config with `cat`. Values that use only A-Z, a-z, 0-9, + and / (sometimes ending in =) are almost certainly base64. There is a command named after the encoding.',
    '`base64 -d` decodes whatever arrives on its standard input, so you need to feed it just the encoded value, not the whole line. `echo <value> | base64 -d` works; so does cutting the value out of the file with `cut -d= -f2-`.',
    `Run \`grep endpoint_b64 ${CONF} | cut -d= -f2- | base64 -d\` and submit the host name from the URL it prints.`,
  ],
  conceptCard: {
    attack: 'Obfuscation of command-and-control (C2) details. Malware has to know where to phone home, and defenders search disks for URLs and domains. Encoding the address as base64 (often layered with XOR or compression) defeats naive string searches and casual inspection while costing the attacker nothing.',
    detection: 'Recognise the alphabet: long runs of A-Za-z0-9+/ with optional = padding, a length that is a multiple of four. Decode and look. Decoded text that is a URL, a shell command or a script is a strong signal. Scanners flag high-entropy strings and base64 that decodes to keywords such as http, /bin/sh or powershell. Pair this with network evidence: regular, small outbound requests on a fixed interval ("beaconing").',
    mitigation: 'Block the decoded host at DNS and the egress firewall and search the rest of the fleet for the same indicator. Remove the implant and its persistence, then rebuild if its origin is unknown. Longer term: default-deny outbound traffic from servers, so an implant cannot reach a host nobody approved, and alert on new binaries and services.',
    commands: [
      { cmd: `cat ${CONF}`, explain: 'read the file and spot which values look encoded' },
      { cmd: 'cut -d= -f2-', explain: 'split on "=" and keep everything from field 2 on; the trailing "-" matters because base64 padding is also "="' },
      { cmd: 'base64 -d', explain: 'decode base64 from standard input (or a file)' },
      { cmd: `echo ${ENDPOINT_B64} | base64 -d`, explain: 'the quick way for a value you can copy and paste' },
    ],
  },
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
