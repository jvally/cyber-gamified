const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHA[n >> 18] + ALPHA[(n >> 12) & 63] +
      (i + 1 < bytes.length ? ALPHA[(n >> 6) & 63] : '=') +
      (i + 2 < bytes.length ? ALPHA[n & 63] : '=');
  }
  return out;
}

/** Decode like GNU `base64 -d`: newlines are skipped; returns what decoded cleanly plus an ok flag. */
export function b64decode(input: string, ignoreGarbage = false): { text: string; ok: boolean } {
  const bytes: number[] = [];
  let ok = true, buf = 0, bits = 0, pad = 0, count = 0;
  for (const ch of input) {
    if (ch === '\n' || ch === '\r') continue;
    if (ch === '=') { pad++; continue; }
    const v = ALPHA.indexOf(ch);
    if (v < 0 || pad > 0) { if (ignoreGarbage && v < 0) continue; ok = false; break; }
    buf = (buf << 6) | v; bits += 6; count++;
    if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 0xff); }
  }
  if (ok && ((count + pad) % 4 !== 0 || pad > 2)) ok = false; // truncated or mis-padded input
  return { text: new TextDecoder('utf-8').decode(new Uint8Array(bytes)), ok };
}
