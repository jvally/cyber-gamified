// Browser front end: xterm.js terminal, mission panel, concept cards, level select.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { BASE_SCORE, Game, HINT_COSTS, PAR_BONUS } from '../levels/engine';
import { LEVELS } from '../levels/index';
import type { Level } from '../levels/types';
import { ProgressStore } from '../progress/store';
import { complete } from './completion';
import { cursorAt, LineEditor } from './lineEditor';

type Attrs = Record<string, string | boolean | (() => void)>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k, v);
    else if (typeof v === 'boolean') { if (v) el.setAttribute(k, ''); }
    else el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}

const GREEN = '\x1b[1;32m', RED = '\x1b[1;31m', BLUE = '\x1b[1;34m', CYAN = '\x1b[36m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', BOLD = '\x1b[1m', OFF = '\x1b[0m';
const IDS = LEVELS.map((l) => l.id);

export class App {
  private term: Terminal;
  private fit = new FitAddon();
  private editor = new LineEditor();
  private store: ProgressStore;
  private game!: Game;
  private index = 0;
  private replay = false;
  /** rows between the start of the prompt and the cursor / the end of the input line */
  private cursorRow = 0;
  private endRow = 0;
  private modalOpen = false;

  private panel = h('aside', { class: 'panel', 'aria-label': 'Mission' });
  private summary = h('span', { class: 'summary' });
  private overlay = h('div', { class: 'overlay', hidden: true });

  constructor(root: HTMLElement, storage: Storage | null) {
    this.store = new ProgressStore(storage);
    const termHost = h('div', { class: 'terminal', 'aria-label': 'Terminal' });
    root.append(
      h('header', { class: 'topbar' },
        h('h1', { 'aria-label': 'ShellShock Academy' }, h('span', { class: 'neon-cyan' }, 'ShellShock'), ' ', h('span', { class: 'neon-lime' }, 'Academy')),
        this.summary,
        h('button', { class: 'btn', click: () => this.showLevelSelect() }, 'Levels'),
      ),
      h('main', { class: 'layout' }, termHost, this.panel),
      this.overlay,
    );
    this.term = new Terminal({
      convertEol: true, cursorBlink: true, fontSize: 14, scrollback: 5000,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      theme: {
        background: '#0a0d1c', foreground: '#dbe4ff', cursor: '#9fef00', cursorAccent: '#0a0d1c', selectionBackground: '#3b2a6b',
        black: '#141d2b', red: '#ff4d6d', green: '#9fef00', yellow: '#ffd447', blue: '#3aa8ff', magenta: '#ff2fd0', cyan: '#2ee6ff', white: '#dbe4ff',
        brightBlack: '#6b7a9c', brightRed: '#ff7a90', brightGreen: '#b8ff3d', brightYellow: '#ffe27a', brightBlue: '#6cc4ff',
        brightMagenta: '#ff6be0', brightCyan: '#7af2ff', brightWhite: '#ffffff',
      },
    });
    this.term.loadAddon(this.fit);
    this.term.open(termHost);
    this.fit.fit();
    window.addEventListener('resize', () => this.fit.fit());
    this.term.onData((data) => this.onData(data));
    this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.modalOpen) this.closeModal(); });
    this.loadLevel(this.store.currentIndex(IDS));
  }

  // ------------------------------------------------------------------ level lifecycle
  private loadLevel(index: number): void {
    this.index = index;
    const level = LEVELS[index];
    this.replay = this.store.get(level.id).completed;
    this.game = new Game(level, {
      hint: () => this.hint(),
      mission: () => `${BOLD}${level.title}${OFF}\n\n${level.story}\n${YELLOW}Objective:${OFF} ${level.objective}\n`,
      levels: () => this.levelsText(),
      reset: () => this.resetLevel(),
      next: () => this.next(),
    });
    this.store.recordAttempt(level.id);
    this.editor = new LineEditor();
    this.term.reset();
    this.term.write(
      `${BOLD}ShellShock Academy${OFF} ${DIM}·${OFF} Level ${index + 1}/${LEVELS.length}: ${BOLD}${level.title}${OFF}` +
      `${this.replay ? ` ${DIM}(replay)${OFF}` : ''}\n${YELLOW}Objective:${OFF} ${level.objective}\n` +
      `${DIM}Type ${OFF}help${DIM} for commands, ${OFF}hint${DIM} for a hint, ${OFF}mission${DIM} for the briefing. Tab completes, ↑ recalls.${OFF}\n\n`,
    );
    this.cursorRow = this.endRow = 0;
    this.redraw();
    this.refresh();
    this.term.focus();
  }

  private resetLevel(): string {
    const hints = this.game.hintsUsed; // hint penalties survive a reset
    this.game.reset();
    this.game.hintsUsed = hints;
    this.store.recordAttempt(this.game.level.id);
    queueMicrotask(() => this.refresh());
    return 'Level reset: files and processes are back to their initial state.\n';
  }

  private next(): string {
    if (this.game.status !== 'won') return 'Finish this level first (or pick another from the Levels menu).\n';
    if (this.index + 1 >= LEVELS.length) return 'That was the last level. Use the Levels menu to replay any of them.\n';
    setTimeout(() => this.loadLevel(this.index + 1));
    return '';
  }

  private hint(): string {
    const hint = this.game.nextHint();
    queueMicrotask(() => this.refresh());
    if (!hint) return 'No more hints: all three are shown in the mission panel.\n';
    return `${YELLOW}Hint ${hint.tier}/3${OFF} ${DIM}(-${hint.cost} points)${OFF}\n${hint.text}\n`;
  }

  private levelsText(): string {
    const rows = LEVELS.map((l, i) => {
      const p = this.store.get(l.id);
      const mark = p.completed ? `${GREEN}done${OFF}  ` : this.store.isUnlocked(IDS, i) ? `${CYAN}open${OFF}  ` : `${DIM}locked${OFF}`;
      return ` ${i === this.index ? '>' : ' '} ${i + 1}. ${mark} ${l.title}${p.completed ? `${DIM}  best ${p.bestScore}${OFF}` : ''}`;
    });
    return rows.join('\n') + `\n${DIM}Use the Levels button (top right) to switch level.${OFF}\n`;
  }

  // ------------------------------------------------------------------ terminal I/O
  private prompt(): { text: string; length: number } {
    const { state } = this.game;
    const home = state.env.HOME;
    const cwd = state.cwd === home ? '~' : state.cwd.startsWith(home + '/') ? '~' + state.cwd.slice(home.length) : state.cwd;
    return {
      text: `${GREEN}${state.user}@${state.hostname}${OFF}:${BLUE}${cwd}${OFF}$ `,
      length: `${state.user}@${state.hostname}:${cwd}$ `.length,
    };
  }

  /** Repaint the prompt and the edit buffer, handling lines that wrap. */
  private redraw(): void {
    const cols = this.term.cols;
    const p = this.prompt();
    const { buffer, cursor } = this.editor;
    let out = (this.cursorRow > 0 ? `\x1b[${this.cursorRow}A` : '') + '\r\x1b[J' + p.text + buffer;
    const total = p.length + buffer.length;
    const end = cursorAt(total, cols);
    if (total > 0 && end.col === 0) out += ' \b'; // push the cursor onto the next row when the line exactly fills one
    const target = cursorAt(p.length + cursor, cols);
    if (end.row > target.row) out += `\x1b[${end.row - target.row}A`;
    out += '\r' + (target.col > 0 ? `\x1b[${target.col}C` : '');
    this.cursorRow = target.row;
    this.endRow = end.row;
    this.term.write(out);
  }

  /** Leave the input line (cursor to its end, then a new line). */
  private leaveLine(): void {
    this.term.write((this.endRow > this.cursorRow ? `\x1b[${this.endRow - this.cursorRow}B` : '') + '\r\n');
    this.cursorRow = this.endRow = 0;
  }

  private onData(data: string): void {
    if (this.modalOpen) return;
    // The editor clears its buffer on submit, so repaint before each event that leaves the line.
    for (const ev of this.editor.feed(data)) {
      if (ev.type === 'change') this.redraw();
      else if (ev.type === 'submit') { this.leaveLine(); this.run(ev.line); this.redraw(); }
      else if (ev.type === 'interrupt') { this.term.write('^C'); this.leaveLine(); this.redraw(); }
      else if (ev.type === 'clear') { this.term.write('\x1b[H\x1b[2J\x1b[3J'); this.cursorRow = this.endRow = 0; this.redraw(); }
      else this.tab();
    }
  }

  private tab(): void {
    const c = complete(this.editor.buffer, this.editor.cursor, this.game.state, this.game.shell.commands);
    if (c.line !== this.editor.buffer) {
      this.editor.set(c.line, c.cursor);
    } else if (c.candidates.length) {
      this.leaveLine();
      const width = Math.max(...c.candidates.map((s) => s.length)) + 2;
      const perRow = Math.max(1, Math.floor(this.term.cols / width));
      for (let i = 0; i < c.candidates.length; i += perRow) {
        this.term.write(c.candidates.slice(i, i + perRow).map((s) => s.padEnd(width)).join('').trimEnd() + '\n');
      }
    }
    this.redraw();
  }

  private run(line: string): void {
    const level = this.game.level;
    const r = this.game.exec(line, { tty: true, cols: this.term.cols });
    let out = r.output;
    if (out !== '' && !out.endsWith('\n') && !out.endsWith('\x1b[3J')) out += '\n';
    if (r.wrongAnswer) out += `${RED}✗ That is not the answer.${OFF} Keep investigating, or type ${BOLD}hint${OFF}.\n`;
    if (r.justFailed) out += `${RED}✗ Level failed.${OFF} ${this.game.failMessage}\nType ${BOLD}reset${OFF} to try again.\n`;
    if (r.justWon) {
      const score = this.game.score();
      const res = this.store.recordWin(level.id, score, this.game.commandCount, this.game.hintsUsed);
      out += `${GREEN}✓ Objective complete!${OFF} Score ${BOLD}${score}${OFF}` +
        `${res.firstClear ? '' : res.newBest ? ' (new best)' : ` (best stays ${this.store.get(level.id).bestScore})`}. ` +
        `${DIM}The shell stays open if you want to keep exploring; type ${OFF}next${DIM} to move on.${OFF}\n`;
      setTimeout(() => this.showCard(level, true), 350);
    }
    this.term.write(out);
    this.refresh();
  }

  // ------------------------------------------------------------------ side panel
  private refresh(): void {
    const { game } = this;
    const level = game.level;
    const best = this.store.get(level.id);
    const won = game.status === 'won';
    this.summary.textContent = `${this.store.completedCount(IDS)}/${LEVELS.length} complete · ${this.store.totalScore(IDS)} pts`;

    const hints = h('ol', { class: 'hints' }, ...level.hints.slice(0, game.hintsUsed).map((t) => h('li', {}, t)));
    const nextCost = HINT_COSTS[game.hintsUsed];
    const hintBtn = h('button', {
      class: 'btn', disabled: game.hintsUsed >= 3,
      click: () => { this.term.write('\r\x1b[J' + this.hint()); this.cursorRow = this.endRow = 0; this.redraw(); this.term.focus(); },
    }, game.hintsUsed >= 3 ? 'All hints shown' : `Reveal hint ${game.hintsUsed + 1} (-${nextCost} pts)`);

    this.panel.replaceChildren(
      h('p', { class: 'tag' }, `Level ${this.index + 1} of ${LEVELS.length}`, this.replay ? h('span', { class: 'badge' }, 'replay') : ''),
      h('h2', {}, level.title),
      h('div', { class: 'story' }, ...level.story.trim().split(/\n\s*\n/).map((para) => h('p', {}, para.replace(/\s*\n\s*/g, ' ')))),
      h('div', { class: `objective ${won ? 'done' : game.status === 'failed' ? 'failed' : ''}` },
        h('strong', {}, won ? '✓ Objective complete' : game.status === 'failed' ? '✗ Level failed: type reset' : 'Objective'),
        h('p', {}, level.objective)),
      h('h3', {}, 'Hints'),
      game.hintsUsed ? hints : h('p', { class: 'muted' }, 'Three tiers: a nudge, an approach, then the commands. Each one costs points.'),
      hintBtn,
      h('h3', {}, 'Score'),
      h('dl', { class: 'stats' },
        h('dt', {}, 'This run'), h('dd', {}, String(game.score())),
        h('dt', {}, 'Commands'), h('dd', {}, `${game.commandCount} (bonus +${PAR_BONUS} at ${game.par} or fewer)`),
        h('dt', {}, 'Best'), h('dd', {}, best.completed ? String(best.bestScore) : 'not yet completed'),
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', click: () => { this.term.write('\r\x1b[J' + this.resetLevel()); this.cursorRow = this.endRow = 0; this.redraw(); this.term.focus(); } }, 'Reset level'),
        best.completed ? h('button', { class: 'btn', click: () => this.showCard(level, won) }, 'Concept card') : '',
        won && this.index + 1 < LEVELS.length ? h('button', { class: 'btn primary', click: () => this.loadLevel(this.index + 1) }, 'Next level') : '',
      ),
    );
  }

  // ------------------------------------------------------------------ modals
  private openModal(...content: (Node | string)[]): void {
    this.overlay.replaceChildren(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, ...content));
    this.overlay.hidden = false;
    this.modalOpen = true;
    this.term.blur();
    this.overlay.querySelector<HTMLElement>('button.primary, button')?.focus({ preventScroll: true });
    this.overlay.scrollTop = 0;
  }
  private closeModal(): void {
    this.overlay.hidden = true;
    this.overlay.replaceChildren();
    this.modalOpen = false;
    this.term.focus();
  }

  private showCard(level: Level, justPlayed: boolean): void {
    const card = level.conceptCard;
    const i = LEVELS.indexOf(level);
    const p = this.store.get(level.id);
    const section = (title: string, body: string): HTMLElement => h('section', {}, h('h3', {}, title), h('p', {}, body));
    const hintCost = HINT_COSTS.slice(0, this.game.hintsUsed).reduce((a, b) => a + b, 0);
    const bonus = this.game.commandCount <= this.game.par;
    const go = (fn: () => void) => () => { this.closeModal(); fn(); };
    this.openModal(
      h('p', { class: 'tag' }, `Concept card · Level ${i + 1}`),
      h('h2', {}, level.title),
      justPlayed ? h('p', { class: 'scoreline' },
        `Score ${this.game.score()} = ${BASE_SCORE} base${hintCost ? ` - ${hintCost} hints` : ''}${bonus ? ` + ${PAR_BONUS} efficiency bonus` : ''}`,
        h('span', { class: 'muted' }, `  ·  best ${p.bestScore}  ·  ${this.game.commandCount} ${this.game.commandCount === 1 ? 'command' : 'commands'}`)) : '',
      section('What the attack is', card.attack),
      section('How defenders detect it', card.detection),
      section('Real-world mitigation', card.mitigation),
      h('section', {}, h('h3', {}, 'Commands used'),
        h('dl', { class: 'cmds' }, ...card.commands.flatMap((c) => [h('dt', {}, h('code', {}, c.cmd)), h('dd', {}, c.explain)]))),
      h('section', { class: 'two-col' },
        h('div', {}, h('h3', {}, 'One clean solution'), h('pre', {}, level.idealSolution.join('\n'))),
        justPlayed ? h('div', {}, h('h3', {}, 'What you ran'), h('pre', {}, this.game.commands.join('\n') || '(nothing)')) : '',
      ),
      h('div', { class: 'actions' },
        i + 1 < LEVELS.length && p.completed ? h('button', { class: 'btn primary', click: go(() => this.loadLevel(i + 1)) }, 'Next level') : '',
        h('button', { class: 'btn', click: go(() => this.loadLevel(i)) }, 'Replay'),
        h('button', { class: 'btn', click: () => this.showLevelSelect() }, 'Levels'),
        h('button', { class: 'btn', click: () => this.closeModal() }, justPlayed ? 'Keep exploring' : 'Close'),
      ),
    );
  }

  private showLevelSelect(): void {
    const go = (fn: () => void) => () => { this.closeModal(); fn(); };
    const rows = LEVELS.map((l, i) => {
      const p = this.store.get(l.id);
      const open = this.store.isUnlocked(IDS, i);
      return h('li', { class: `level ${p.completed ? 'done' : open ? 'open' : 'locked'}` },
        h('span', { class: 'num' }, p.completed ? '✓' : String(i + 1)),
        h('div', { class: 'info' },
          h('strong', {}, l.title),
          h('span', { class: 'muted' }, p.completed
            ? `best ${p.bestScore} · fewest commands ${p.bestCommands} · ${p.attempts} ${p.attempts === 1 ? 'attempt' : 'attempts'}`
            : open ? l.objective : `Complete level ${i} to unlock`)),
        h('div', { class: 'actions' },
          p.completed ? h('button', { class: 'btn', click: () => this.showCard(l, false) }, 'Card') : '',
          h('button', { class: `btn ${!p.completed && open ? 'primary' : ''}`, disabled: !open, click: go(() => this.loadLevel(i)) }, p.completed ? 'Replay' : 'Play'),
        ));
    });
    this.openModal(
      h('h2', {}, 'Levels'),
      h('p', { class: 'muted' }, `${this.store.completedCount(IDS)} of ${LEVELS.length} complete · ${this.store.totalScore(IDS)} points. Replays keep your best score.`),
      h('ol', { class: 'levels' }, ...rows),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', click: () => this.closeModal() }, 'Close'),
        h('button', {
          class: 'btn danger',
          click: () => {
            if (!window.confirm('Erase all progress and scores? This cannot be undone.')) return;
            this.store.reset();
            this.closeModal();
            this.loadLevel(0);
          },
        }, 'Reset all progress'),
      ),
    );
  }
}
