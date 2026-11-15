/** Convert one glob component (`*`, `?`, `[...]`, `\x` = literal x) to an anchored RegExp. */
export function globToRegex(glob: string, flags = ''): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) { re += escapeRe(glob[++i]); continue; }
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '[') {
      let j = i + 1;
      if (glob[j] === '!' || glob[j] === '^') j++;
      if (glob[j] === ']') j++;
      while (j < glob.length && glob[j] !== ']') j++;
      if (j < glob.length) {
        let body = glob.slice(i + 1, j);
        const neg = body[0] === '!' || body[0] === '^';
        if (neg) body = body.slice(1);
        re += `[${neg ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')}]`;
        i = j;
        continue;
      }
    }
    re += escapeRe(c);
  }
  return new RegExp(`^${re}$`, flags);
}
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
export const hasGlob = (s: string): boolean => /(^|[^\\])(\\\\)*[*?[]/.test(s);
export const unescapeGlob = (s: string): string => s.replace(/\\(.)/g, '$1');
