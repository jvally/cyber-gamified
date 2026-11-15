import { describe, expect, it } from 'vitest';
import { tokenize, ShellSyntaxError } from '../src/shell/tokenizer';
import { parse } from '../src/shell/parser';
import { globToRegex } from '../src/shell/glob';
import { box } from './helpers';
import { dir, file } from '../src/levels/builders';

const words = (s: string): string[] =>
  tokenize(s).map((t) => (t.type === 'op' ? `<${t.op}>` : t.parts.map((p) => (p.q === 'none' ? p.text : `${p.q[0]}{${p.text}}`)).join('')));

describe('tokenizer', () => {
  it.each<[string, string[]]>([
    ['ls -la /tmp', ['ls', '-la', '/tmp']],
    ['  a   b  ', ['a', 'b']],
    ['a|b', ['a', '<|>', 'b']],
    ['a | b > c >> d < e', ['a', '<|>', 'b', '<>>', 'c', '<>>>', 'd', '<<>', 'e']],
    ['a 2> e 2>> f 2>&1', ['a', '<2>>', 'e', '<2>>>', 'f', '<2>&1>']],
    ['a>b', ['a', '<>>', 'b']],
    ['echo 2', ['echo', '2']],
    ['echo x2>f', ['echo', 'x2', '<>>', 'f']],
    ['a && b || c ; d', ['a', '<&&>', 'b', '<||>', 'c', '<;>', 'd']],
    ["echo 'a b' \"c d\"", ['echo', 's{a b}', 'd{c d}']],
    ["a'b'\"c\"d", ['as{b}d{c}d']],
    ['echo ""', ['echo', 'd{}']],
    ["echo ''", ['echo', 's{}']],
    ['echo a\\ b', ['echo', 'as{ }b']],
    ['echo "a\\"b\\$c\\nd"', ['echo', 'd{a}s{"}d{b}s{$}d{c\\nd}']],
    ['echo # comment', ['echo']],
    ['echo a#b', ['echo', 'a#b']],
    ["grep 'a|b' f", ['grep', 's{a|b}', 'f']],
    ['', []],
  ])('%s', (input, want) => expect(words(input)).toEqual(want));

  it.each([
    ["echo 'abc", /unexpected EOF/], ['echo "abc', /unexpected EOF/], ['echo $(id)', /command substitution/],
    ['echo `id`', /command substitution/], ['echo "$(id)"', /command substitution/], ['(ls)', /subshell/],
    ['sleep 5 &', /background/], ['cat <<EOF', /here-document/], ['ls &> f', /redirection/], ['ls >&2', /redirection/],
  ])('rejects %s', (input, msg) => {
    expect(() => tokenize(input)).toThrow(ShellSyntaxError);
    expect(() => tokenize(input)).toThrow(msg);
  });
});

describe('parser', () => {
  it('builds pipelines with redirects', () => {
    const [item] = parse('grep x < in | sort -r > out 2>&1');
    expect(item.pipeline.commands).toHaveLength(2);
    expect(item.pipeline.commands[0].redirects.map((r) => r.op)).toEqual(['<']);
    expect(item.pipeline.commands[1].argv).toHaveLength(2);
    expect(item.pipeline.commands[1].redirects.map((r) => r.op)).toEqual(['>', '2>&1']);
  });
  it('builds lists with joiners', () => {
    expect(parse('a && b || c; d;').map((i) => i.op)).toEqual([null, '&&', '||', ';']);
  });
  it('allows a redirect with no command', () => expect(parse('> f')[0].pipeline.commands[0].argv).toEqual([]));
  it.each([
    ['| ls', "`|'"], ['ls |', "`newline'"], ['ls | | wc', "`|'"], ['ls >', "`newline'"], ['ls > | wc', "`|'"],
    ['ls &&', "`newline'"], ['&& ls', "`&&'"], ['ls ;; ls', "`;'"], ['; ls', "`;'"],
  ])('syntax error: %s', (input, tok) => expect(() => parse(input)).toThrow(`syntax error near unexpected token ${tok}`));
});

describe('glob patterns', () => {
  it.each([
    ['*.txt', 'a.txt', true], ['*.txt', 'a.txt.bak', false], ['?.c', 'a.c', true], ['?.c', 'ab.c', false],
    ['[abc]x', 'bx', true], ['[!abc]x', 'bx', false], ['[!abc]x', 'dx', true], ['[a-c]*', 'cat', true],
    ['a.b', 'axb', false], ['\\*', '*', true], ['\\*', 'a', false], ['[', '[', true], ['*', 'a/b', false],
    ['a+b', 'a+b', true], ['(x)', '(x)', true],
  ])('%s vs %s -> %s', (g, s, want) => expect(globToRegex(g).test(s)).toBe(want));
});

describe('expansion', () => {
  const mk = () => box([
    dir('/home/analyst/d', { owner: 'analyst' }),
    file('/home/analyst/d/a.txt', '', { owner: 'analyst' }), file('/home/analyst/d/b.txt', '', { owner: 'analyst' }),
    file('/home/analyst/d/.hidden', '', { owner: 'analyst' }), file('/home/analyst/d/my file.md', '', { owner: 'analyst' }),
  ]);
  it.each([
    ['echo $HOME', '/home/analyst\n'], ['echo "$USER@$HOSTNAME"', 'analyst@web01\n'], ["echo '$HOME'", '$HOME\n'],
    ['echo ${USER}x', 'analystx\n'], ['echo $NOPE.', '.\n'], ['echo "\\$HOME"', '$HOME\n'], ['echo $', '$\n'],
    ['echo ~', '/home/analyst\n'], ['echo ~/x', '/home/analyst/x\n'], ['echo "~"', '~\n'], ['echo a~', 'a~\n'],
    ['echo $PWD', '/home/analyst\n'], ['echo d/*.txt', 'd/a.txt d/b.txt\n'], ['echo d/*', 'd/a.txt d/b.txt d/my file.md\n'],
    ['echo d/.*', 'd/.hidden\n'], ['echo "d/*"', 'd/*\n'], ['echo d/*.nope', 'd/*.nope\n'], ['echo /home/*/d/?.txt', '/home/analyst/d/a.txt /home/analyst/d/b.txt\n'],
    ['echo ~/d/a*', '/home/analyst/d/a.txt\n'], ['echo d/[b-z].txt', 'd/b.txt\n'], ['echo $NOPE', '\n'], ['echo "$NOPE" x', ' x\n'],
  ])('%s', (cmd, want) => expect(mk().out(cmd)).toBe(want));
  it('$? reflects the previous exit status', () => {
    const b = mk();
    expect(b.out('false; echo $?; true; echo $?; nope 2>/dev/null; echo $?')).toBe('1\n0\n127\n');
  });
  it('glob results are separate arguments, even with spaces in names', () => {
    expect(mk().out('ls -1 d/*.md')).toBe('d/my file.md\n');
  });
});
