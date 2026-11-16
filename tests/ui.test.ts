import { describe, expect, it } from 'vitest';
import { cursorAt, LineEditor } from '../src/ui/lineEditor';
import { complete } from '../src/ui/completion';
import { parseProgress, ProgressStore, STORAGE_KEY, KV } from '../src/progress/store';
import { box } from './helpers';
import { dir, file } from '../src/levels/builders';

const typed = (e: LineEditor, s: string) => e.feed(s);
const UP = '\x1b[A', DOWN = '\x1b[B', LEFT = '\x1b[D', RIGHT = '\x1b[C', HOME = '\x1b[H', END = '\x1b[F', DEL = '\x1b[3~', BS = '\x7f';

describe('LineEditor', () => {
  it('inserts, moves and deletes', () => {
    const e = new LineEditor();
    typed(e, 'helo');
    typed(e, LEFT); typed(e, 'l');
    expect([e.buffer, e.cursor]).toEqual(['hello', 4]);
    typed(e, HOME + 'x' + END + 'y');
    expect(e.buffer).toBe('xhelloy');
    typed(e, BS + HOME + DEL);
    expect([e.buffer, e.cursor]).toEqual(['hello', 0]);
    typed(e, LEFT + BS); // no-ops at the start
    typed(e, END + RIGHT + DEL); // no-ops at the end
    expect([e.buffer, e.cursor]).toEqual(['hello', 5]);
  });
  it('submits lines and keeps history without blanks or immediate duplicates', () => {
    const e = new LineEditor();
    expect(typed(e, 'ls\r')).toEqual([{ type: 'change' }, { type: 'submit', line: 'ls' }]);
    typed(e, 'ls\r'); typed(e, '   \r'); typed(e, 'pwd\r'); typed(e, '\r');
    expect(e.history).toEqual(['ls', 'pwd']);
    expect(e.buffer).toBe('');
  });
  it('walks history with the arrow keys and restores the draft', () => {
    const e = new LineEditor();
    typed(e, 'one\rtwo\rthree\r');
    typed(e, 'draft');
    typed(e, UP); expect(e.buffer).toBe('three');
    typed(e, UP + UP + UP + UP); expect(e.buffer).toBe('one');
    typed(e, DOWN); expect(e.buffer).toBe('two');
    typed(e, DOWN + DOWN); expect(e.buffer).toBe('draft');
    typed(e, DOWN); expect(e.buffer).toBe('draft');
    typed(e, UP + '!\r');
    expect(e.history[e.history.length - 1]).toBe('three!');
  });
  it('control keys', () => {
    const e = new LineEditor();
    typed(e, 'grep -c foo /var/log/auth.log');
    typed(e, '\x17'); expect(e.buffer).toBe('grep -c foo /var/log/');
    typed(e, '\x01\x1bf'); expect(e.cursor).toBe(4);
    typed(e, '\x0b'); expect(e.buffer).toBe('grep');
    typed(e, ' x\x01\x06\x06'); expect(e.cursor).toBe(2);
    typed(e, '\x15'); expect([e.buffer, e.cursor]).toEqual(['ep x', 0]);
    typed(e, '\x05\x1bb'); expect(e.cursor).toBe(3);
    expect(typed(e, '\x03')).toEqual([{ type: 'interrupt', line: 'ep x' }]);
    expect(e.buffer).toBe('');
    expect(typed(e, '\x0c')).toEqual([{ type: 'clear' }]);
    expect(typed(e, '\t')).toEqual([{ type: 'tab' }]);
  });
  it('handles pasted multi-line text and ignores unknown escape sequences', () => {
    const e = new LineEditor();
    const ev = typed(e, 'echo a\r\necho b\npartial');
    expect(ev.filter((x) => x.type === 'submit').map((x) => (x as { line: string }).line)).toEqual(['echo a', 'echo b']);
    expect(e.buffer).toBe('partial');
    typed(e, '\x1b[15~\x1b[200~\x1bOP\x00');
    expect(e.buffer).toBe('partial');
    typed(e, ' ✓é');
    expect(e.buffer).toBe('partial ✓é');
  });
  it('cursorAt wraps by terminal width', () => {
    expect(cursorAt(0, 80)).toEqual({ row: 0, col: 0 });
    expect(cursorAt(79, 80)).toEqual({ row: 0, col: 79 });
    expect(cursorAt(80, 80)).toEqual({ row: 1, col: 0 });
    expect(cursorAt(170, 80)).toEqual({ row: 2, col: 10 });
  });
});

describe('tab completion', () => {
  const A = { owner: 'analyst' };
  const b = box([
    dir('/home/analyst/projects', A), dir('/home/analyst/pictures', A), file('/home/analyst/plan.txt', '', A),
    file('/home/analyst/notes.txt', '', A), file('/home/analyst/my file.txt', '', A), dir('/home/analyst/.ssh', { ...A, mode: 0o700 }),
    file('/home/analyst/.ssh/id_ed25519', '', A), file('/var/log/auth.log', ''), file('/var/log/auth.log.1', ''), file('/var/log/syslog', ''),
  ]);
  const c = (line: string, cursor = line.length) => complete(line, cursor, b.state, b.sh.commands);

  it('completes command names in command position', () => {
    expect(c('sha')).toMatchObject({ line: 'sha256sum ', candidates: [] });
    expect(c('ch').candidates).toEqual(['chmod', 'chown']);
    expect(c('ch').line).toBe('ch');
    expect(c('cat x | gr').line).toBe('cat x | grep ');
    expect(c('true && wh').line).toBe('true && whoami ');
    expect(c('sudo ki').line).toBe('sudo kill ');
    expect(c('su').line).toBe('su');
    expect(c('su').candidates).toEqual(['submit', 'sudo']);
    expect(c('help so').line).toBe('help sort ');
    expect(c('zz')).toMatchObject({ line: 'zz', candidates: [] });
    expect(c('').candidates.length).toBeGreaterThan(30);
  });
  it('completes paths, adding / for directories and a space for files', () => {
    expect(c('cat no').line).toBe('cat notes.txt ');
    expect(c('ls pro').line).toBe('ls projects/');
    expect(c('cat p')).toMatchObject({ line: 'cat p', candidates: ['pictures/', 'plan.txt', 'projects/'] });
    expect(c('cat /var/log/au')).toMatchObject({ line: 'cat /var/log/auth.log', candidates: ['auth.log', 'auth.log.1'] });
    expect(c('cat /v').line).toBe('cat /var/');
    expect(c('cat ~/.s').line).toBe('cat ~/.ssh/');
    expect(c('cat ~/.ssh/').line).toBe('cat ~/.ssh/id_ed25519 ');
    expect(c('ls /nope/x')).toMatchObject({ line: 'ls /nope/x', candidates: [] });
    expect(c('ls /root/')).toMatchObject({ candidates: [] });
  });
  it('hides dotfiles unless asked, and cd only offers directories', () => {
    expect(c('ls ').candidates).toEqual(['my file.txt', 'notes.txt', 'pictures/', 'plan.txt', 'projects/']);
    expect(c('ls .').candidates).toEqual(['.bashrc', '.profile', '.ssh/']);
    expect(c('cd p').candidates).toEqual(['pictures/', 'projects/']);
    expect(c('cd pr').line).toBe('cd projects/');
  });
  it('escapes spaces and completes in the middle of a line', () => {
    expect(c('cat my').line).toBe('cat my\\ file.txt ');
    expect(c('cat my\\ f').line).toBe('cat my\\ file.txt ');
    expect(c('cat no | wc -l', 6)).toMatchObject({ line: 'cat notes.txt  | wc -l', cursor: 14 });
    expect(c('echo hi > no').line).toBe('echo hi > notes.txt ');
  });
  it('completes option flags from the help text', () => {
    expect(c('find / -na').line).toBe('find / -name ');
    expect(c('ls -').candidates).toEqual(expect.arrayContaining(['-l', '-a', '-R']));
    expect(c('find / -m').candidates).toEqual(['-maxdepth', '-mindepth', '-mmin', '-mtime']);
    expect(c('sudo find / -per').line).toBe('sudo find / -perm ');
  });
});

describe('ProgressStore', () => {
  const mem = (init: Record<string, string> = {}): KV & { map: Record<string, string> } => {
    const map = { ...init };
    return { map, getItem: (k) => map[k] ?? null, setItem: (k, v) => { map[k] = v; }, removeItem: (k) => { delete map[k]; } };
  };
  const ids = ['a', 'b', 'c'];

  it('starts empty, unlocks in order and persists', () => {
    const kv = mem();
    const s = new ProgressStore(kv);
    expect([s.isUnlocked(ids, 0), s.isUnlocked(ids, 1), s.currentIndex(ids), s.totalScore(ids)]).toEqual([true, false, 0, 0]);
    s.recordAttempt('a');
    expect(s.recordWin('a', 90, 4, 1)).toEqual({ newBest: true, firstClear: true });
    expect([s.isUnlocked(ids, 1), s.isUnlocked(ids, 2), s.currentIndex(ids), s.completedCount(ids)]).toEqual([true, false, 1, 1]);
    const again = new ProgressStore(kv);
    expect(again.get('a')).toEqual({ completed: true, bestScore: 90, attempts: 1, bestCommands: 4, hintsUsed: 1 });
  });
  it('replay keeps the best score and the fewest commands', () => {
    const s = new ProgressStore(mem());
    s.recordWin('a', 90, 4, 1);
    expect(s.recordWin('a', 50, 3, 3)).toEqual({ newBest: false, firstClear: false });
    expect(s.get('a')).toMatchObject({ bestScore: 90, bestCommands: 3, hintsUsed: 1 });
    expect(s.recordWin('a', 110, 9, 0)).toEqual({ newBest: true, firstClear: false });
    expect(s.get('a')).toMatchObject({ bestScore: 110, bestCommands: 3, hintsUsed: 0 });
    s.recordWin('b', 100, 2, 0); s.recordWin('c', 100, 2, 0);
    expect([s.totalScore(ids), s.currentIndex(ids)]).toEqual([310, 2]);
  });
  it.each([
    ['not json', '{oops'], ['wrong version', '{"version":2,"levels":{"a":{"completed":true}}}'], ['array', '[1,2]'],
    ['null', 'null'], ['levels is array', '{"version":1,"levels":[]}'], ['string', '"hi"'],
  ])('ignores corrupted data: %s', (_n, raw) => {
    expect(parseProgress(raw)).toEqual({ version: 1, levels: {} });
    expect(new ProgressStore(mem({ [STORAGE_KEY]: raw })).completedCount(ids)).toBe(0);
  });
  it('sanitises individual fields', () => {
    const p = parseProgress('{"version":1,"levels":{"a":{"completed":"yes","bestScore":-5,"attempts":"3","bestCommands":2.9},"b":7}}');
    expect(p.levels).toEqual({ a: { completed: false, bestScore: 0, attempts: 0, bestCommands: 2, hintsUsed: null } });
  });
  it('survives storage that throws, and reset clears everything', () => {
    const broken: KV = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('x'); } };
    const s = new ProgressStore(broken);
    expect(() => { s.recordAttempt('a'); s.recordWin('a', 100, 1, 0); s.reset(); }).not.toThrow();
    const kv = mem();
    const t = new ProgressStore(kv);
    t.recordWin('a', 100, 1, 0);
    t.reset();
    expect([t.completedCount(ids), kv.map[STORAGE_KEY]]).toEqual([0, undefined]);
    expect(new ProgressStore(null).get('zzz').attempts).toBe(0);
  });
});
