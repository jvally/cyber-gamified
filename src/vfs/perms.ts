// Mode-string formatting and chmod mode parsing (octal + symbolic).

export function modeString(mode: number, isDir: boolean): string {
  const bit = (shift: number, special: number, ch: string): string => {
    const r = mode & (4 << shift) ? 'r' : '-';
    const w = mode & (2 << shift) ? 'w' : '-';
    const x = mode & (1 << shift);
    const s = mode & special;
    return r + w + (s ? (x ? ch : ch.toUpperCase()) : x ? 'x' : '-');
  };
  return (isDir ? 'd' : '-') + bit(6, 0o4000, 's') + bit(3, 0o2000, 's') + bit(0, 0o1000, 't');
}

/**
 * Apply a chmod mode spec to an existing mode. Returns null if the spec is invalid.
 * A clause with no "who" (e.g. `+w`) behaves like `a` filtered through the umask, as in GNU chmod.
 */
export function applyMode(spec: string, old: number, isDir: boolean, umask = 0o022): number | null {
  if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8);
  let mode = old;
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)((?:[+\-=][rwxXstugo]*)+)$/.exec(clause);
    if (!m) return null;
    const whoRaw = m[1];
    const who = whoRaw === '' || whoRaw.includes('a') ? 'ugo' : whoRaw;
    for (const [, op, perms] of m[2].matchAll(/([+\-=])([rwxXstugo]*)/g)) {
      let bits = 0;
      for (const w of who) {
        const shift = w === 'u' ? 6 : w === 'g' ? 3 : 0;
        for (const p of perms) {
          if (p === 'r') bits |= 4 << shift;
          else if (p === 'w') bits |= 2 << shift;
          else if (p === 'x') bits |= 1 << shift;
          else if (p === 'X') { if (isDir || mode & 0o111) bits |= 1 << shift; }
          else if (p === 's') { if (w === 'u') bits |= 0o4000; if (w === 'g') bits |= 0o2000; }
          else if (p === 't') bits |= 0o1000;
          else {
            const src = (mode >> (p === 'u' ? 6 : p === 'g' ? 3 : 0)) & 7;
            bits |= src << shift;
          }
        }
      }
      if (whoRaw === '') bits &= ~umask;
      if (op === '+') mode |= bits;
      else if (op === '-') mode &= ~bits;
      else {
        let clear = 0;
        for (const w of who) clear |= 7 << (w === 'u' ? 6 : w === 'g' ? 3 : 0);
        mode = (mode & ~clear) | bits;
      }
    }
  }
  return mode & 0o7777;
}
