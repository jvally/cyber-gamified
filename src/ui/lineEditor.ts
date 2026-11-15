// Readline-style line editing, independent of the terminal widget so it can be unit tested.

export type EditorEvent =
  | { type: 'submit'; line: string }
  | { type: 'tab' }
  | { type: 'interrupt'; line: string }
  | { type: 'clear' }
  | { type: 'change' };

const KEY_RE = /\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b[\s\S]|\r\n|[\s\S]/gu;
const isWord = (c: string): boolean => /[^\s/|;&<>]/.test(c);

export class LineEditor {
  buffer = '';
  cursor = 0;
  history: string[] = [];
  private index = 0;
  private stash = '';

  set(buffer: string, cursor = buffer.length): void {
    this.buffer = buffer;
    this.cursor = Math.max(0, Math.min(cursor, buffer.length));
  }

  private wordLeft(): number {
    let i = this.cursor;
    while (i > 0 && !isWord(this.buffer[i - 1])) i--;
    while (i > 0 && isWord(this.buffer[i - 1])) i--;
    return i;
  }
  private wordRight(): number {
    let i = this.cursor;
    while (i < this.buffer.length && !isWord(this.buffer[i])) i++;
    while (i < this.buffer.length && isWord(this.buffer[i])) i++;
    return i;
  }
  private recall(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next > this.history.length) return;
    if (this.index === this.history.length) this.stash = this.buffer;
    this.index = next;
    this.set(next === this.history.length ? this.stash : this.history[next]);
  }

  /** Feed raw terminal input (keys or pasted text). Returns what happened, in order. */
  feed(data: string): EditorEvent[] {
    const events: EditorEvent[] = [];
    const change = (): void => { if (events[events.length - 1]?.type !== 'change') events.push({ type: 'change' }); };
    for (const key of data.match(KEY_RE) ?? []) {
      const { buffer: b, cursor: c } = this;
      switch (key) {
        case '\r': case '\n': case '\r\n': {
          const line = b;
          if (line.trim() !== '' && this.history[this.history.length - 1] !== line) this.history.push(line);
          this.index = this.history.length;
          this.stash = '';
          this.set('');
          events.push({ type: 'submit', line });
          break;
        }
        case '\t': events.push({ type: 'tab' }); break;
        case '\x03': events.push({ type: 'interrupt', line: b }); this.set(''); this.index = this.history.length; break;
        case '\x0c': events.push({ type: 'clear' }); break;
        case '\x7f': case '\b': if (c > 0) { this.set(b.slice(0, c - 1) + b.slice(c), c - 1); change(); } break;
        case '\x1b[3~': case '\x04': if (c < b.length) { this.set(b.slice(0, c) + b.slice(c + 1), c); change(); } break;
        case '\x1b[D': case '\x1bOD': case '\x02': if (c > 0) { this.cursor--; change(); } break;
        case '\x1b[C': case '\x1bOC': case '\x06': if (c < b.length) { this.cursor++; change(); } break;
        case '\x1b[A': case '\x1bOA': case '\x10': this.recall(-1); change(); break;
        case '\x1b[B': case '\x1bOB': case '\x0e': this.recall(1); change(); break;
        case '\x1b[H': case '\x1bOH': case '\x1b[1~': case '\x01': this.cursor = 0; change(); break;
        case '\x1b[F': case '\x1bOF': case '\x1b[4~': case '\x05': this.cursor = b.length; change(); break;
        case '\x1b[1;5D': case '\x1b[1;3D': case '\x1bb': this.cursor = this.wordLeft(); change(); break;
        case '\x1b[1;5C': case '\x1b[1;3C': case '\x1bf': this.cursor = this.wordRight(); change(); break;
        case '\x15': this.set(b.slice(c), 0); change(); break;
        case '\x0b': this.set(b.slice(0, c), c); change(); break;
        case '\x17': case '\x1b\x7f': { const i = this.wordLeft(); this.set(b.slice(0, i) + b.slice(c), i); change(); break; }
        default:
          if (key.length >= 1 && key >= ' ' && !key.startsWith('\x1b')) {
            this.set(b.slice(0, c) + key + b.slice(c), c + key.length);
            change();
          }
      }
    }
    return events;
  }
}

/** Where the cursor ends up (row, col) after `chars` characters are printed from column 0 in a `cols`-wide terminal. */
export const cursorAt = (chars: number, cols: number): { row: number; col: number } =>
  ({ row: Math.floor(chars / cols), col: chars % cols });
