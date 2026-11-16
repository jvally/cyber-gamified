import { sha256 } from '../../crypto/sha256';
import { b64decode, b64encode } from '../../crypto/base64';
import { abs, Command, fsMsg, parseOpts, readInputs, splitLines } from './types';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const sha256sum: Command = {
  run(ctx) {
    const o = parseOpts(ctx, { flags: 'cbt', long: { '--check': 'c', '--quiet': '', '--status': '' } });
    if (!o) return 1;
    const { vfs } = ctx.state;
    let code = 0;
    if (!o.f.c) {
      for (const f of o.rest.length ? o.rest : ['-']) {
        const [input] = readInputs(ctx, [f]);
        if (!input) { code = 1; continue; }
        ctx.out(`${sha256(input.content)}  ${f}\n`);
      }
      return code;
    }
    for (const listFile of o.rest.length ? o.rest : ['-']) {
      const [list] = readInputs(ctx, [listFile]);
      if (!list) { code = 1; continue; }
      let bad = 0, unreadable = 0, malformed = 0, valid = 0;
      for (const line of splitLines(list.content)) {
        const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
        if (!m) { malformed++; continue; }
        valid++;
        let content: string;
        try { content = vfs.readFile(abs(ctx, m[2]), ctx.cred); } catch (e) {
          ctx.err(`sha256sum: ${m[2]}: ${fsMsg(e)}\n`);
          ctx.out(`${m[2]}: FAILED open or read\n`);
          unreadable++;
          continue;
        }
        const ok = sha256(content) === m[1].toLowerCase();
        ctx.out(`${m[2]}: ${ok ? 'OK' : 'FAILED'}\n`);
        if (!ok) bad++;
      }
      const shown = listFile === '-' ? 'standard input' : listFile;
      if (valid === 0) { ctx.err(`sha256sum: ${shown}: no properly formatted checksum lines found\n`); code = 1; continue; }
      if (malformed) ctx.err(`sha256sum: WARNING: ${plural(malformed, 'line is', 'lines are')} improperly formatted\n`);
      if (unreadable) ctx.err(`sha256sum: WARNING: ${plural(unreadable, 'listed file', 'listed files')} could not be read\n`);
      if (bad) ctx.err(`sha256sum: WARNING: ${plural(bad, 'computed checksum', 'computed checksums')} did NOT match\n`);
      if (bad || unreadable) code = 1;
    }
    return code;
  },
  help: {
    summary: 'compute or verify SHA-256 checksums',
    usage: 'sha256sum [FILE]...   |   sha256sum -c CHECKSUMS',
    options: [['(no option)', 'print "<hash>  <file>" for each file (or stdin)'], ['-c FILE', 'read hashes from FILE and verify each listed file: OK / FAILED']],
    notes: 'A cryptographic hash changes completely if even one byte of the file changes.',
    examples: [['sha256sum -c /opt/baseline/SHA256SUMS', 'verify files against a known-good baseline'], ['sha256sum /usr/local/bin/*', 'hash every file in a directory']],
  },
};

const base64: Command = {
  run(ctx) {
    const o = parseOpts(ctx, { flags: 'dDi', values: 'w', long: { '--decode': 'd', '--wrap': 'w', '--ignore-garbage': 'i' } });
    if (!o) return 1;
    if (o.rest.length > 1) { ctx.err(`base64: extra operand '${o.rest[1]}'\nTry 'base64 --help' for more information.\n`); return 1; }
    const [input] = readInputs(ctx, o.rest);
    if (!input) return 1;
    if (o.f.d || o.f.D) {
      const { text, ok } = b64decode(input.content, !!o.f.i);
      ctx.out(text);
      if (!ok) { ctx.err('base64: invalid input\n'); return 1; }
      return 0;
    }
    const wrap = o.v.w === undefined ? 76 : parseInt(o.v.w, 10);
    if (Number.isNaN(wrap) || wrap < 0) { ctx.err(`base64: invalid wrap size: '${o.v.w}'\n`); return 1; }
    const enc = b64encode(input.content);
    if (wrap === 0) { ctx.out(enc); return 0; }
    for (let i = 0; i < enc.length; i += wrap) ctx.out(enc.slice(i, i + wrap) + '\n');
    return 0;
  },
  help: {
    summary: 'base64 encode or decode data',
    usage: 'base64 [-d] [-w COLS] [FILE]',
    options: [['-d', 'decode'], ['-w COLS', 'wrap encoded lines at COLS characters (default 76; 0 = no wrap)'], ['-i', 'when decoding, ignore non-alphabet characters']],
    notes: 'Base64 is an *encoding*, not encryption: anyone can reverse it. Decoding is strict, so stray spaces cause "invalid input".',
    examples: [['echo "c2VjcmV0" | base64 -d', 'decode a suspicious string'], ['base64 -d payload.b64', 'decode a file']],
  },
};

export const crypto = { sha256sum, base64 };
