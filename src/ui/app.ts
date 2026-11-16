// Browser front end: the 2D facility map, the terminal for each task, the mission panel and the modals.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { BASE_SCORE, createSession, HINT_COSTS, PAR_BONUS, Session } from '../levels/engine';
import { ALL_LEVELS, Module, MODULES } from '../levels/index';
import type { LevelMeta } from '../levels/types';
import { ProgressStore } from '../progress/store';
import { buildWorld, Target, WorldMap } from '../world/map';
import { WorldView } from '../world/view';
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

const GREEN = '\x1b[1;32m', RED = '\x1b[1;31m', CYAN = '\x1b[36m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', BOLD = '\x1b[1m', OFF = '\x1b[0m';
const moduleOf = (level: LevelMeta): Module => MODULES.find((m) => m.id === level.module)!;
const idsOf = (m: Module): string[] => m.levels.map((l) => l.id);
const ALL_IDS = ALL_LEVELS.map((l) => l.id);

export class App {
  private term: Terminal;
  private fit = new FitAddon();
  private editor = new LineEditor();
  private store: ProgressStore;
  private map: WorldMap = buildWorld(MODULES);
  private world: WorldView;
  private mode: 'world' | 'station' = 'world';
  private game: Session | null = null;
  private replay = false;
  /** rows between the start of the prompt and the cursor / the end of the input line */
  private cursorRow = 0;
  private endRow = 0;
  private modalOpen = false;
  private toastTimer = 0;

  private panel = h('aside', { class: 'panel', 'aria-label': 'Mission' });
  private summary = h('span', { class: 'summary' });
  private overlay = h('div', { class: 'overlay', hidden: true });
  private canvas = h('canvas', { class: 'world', 'aria-label': 'Facility map. Use the Levels button to open tasks without walking.' });
  private termHost = h('div', { class: 'term-host', 'aria-label': 'Terminal', hidden: true });
  private hud = h('div', { class: 'hud', hidden: true });
  private toast = h('div', { class: 'toast', hidden: true, role: 'status' });
  private mapBtn = h('button', { class: 'btn', hidden: true, click: () => this.leaveStation() }, 'Back to map');

  constructor(root: HTMLElement, storage: Storage | null) {
    this.store = new ProgressStore(storage);
    root.append(
      h('header', { class: 'topbar' },
        h('h1', { 'aria-label': 'ShellShock Academy' }, h('span', { class: 'neon-cyan' }, 'ShellShock'), ' ', h('span', { class: 'neon-lime' }, 'Academy')),
        this.summary,
        this.mapBtn,
        h('button', { class: 'btn', click: () => this.showLevelSelect() }, 'Levels'),
      ),
      h('main', { class: 'layout' }, h('div', { class: 'stage' }, this.canvas, this.termHost, this.hud, this.toast), this.panel),
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
    this.term.open(this.termHost);
    this.term.onData((data) => this.onData(data));
    window.addEventListener('resize', () => { if (this.mode === 'station') this.fit.fit(); });

    this.world = new WorldView(this.canvas, this.map, {
      unlocked: (id) => this.unlocked(id),
      done: (id) => this.store.get(id).completed,
      interact: (t) => this.interact(t),
      prompt: (t) => this.showPrompt(t),
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.modalOpen) { this.closeModal(); return; }
      if (this.mode !== 'world' || this.modalOpen || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return;
      if (this.world.keyDown(e.key)) e.preventDefault();
    });
    document.addEventListener('keyup', (e) => this.world.keyUp(e.key));
    this.canvas.addEventListener('pointerdown', (e) => { if (this.mode === 'world' && !this.modalOpen) this.world.pointer(e.clientX, e.clientY); });
    this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.closeModal(); });

    this.world.start();
    this.refresh();
    if (this.store.completedCount(ALL_IDS) === 0) this.showBriefing();
  }

  // ------------------------------------------------------------------ progress helpers
  private unlocked(levelId: string): boolean {
    const level = ALL_LEVELS.find((l) => l.id === levelId);
    if (!level) return false;
    const ids = idsOf(moduleOf(level));
    return this.store.isUnlocked(ids, ids.indexOf(levelId));
  }
  private labelOf(level: LevelMeta): string {
    return this.map.stations.find((s) => s.levelId === level.id)?.label ?? '';
  }
  private nextInModule(level: LevelMeta): LevelMeta | undefined {
    const levels = moduleOf(level).levels;
    return levels[levels.indexOf(level) + 1];
  }

  // ------------------------------------------------------------------ world mode
  private interact(t: Target): void {
    if (t.tile.kind === 'npc') { this.showBriefing(); return; }
    const level = ALL_LEVELS.find((l) => l.id === t.tile.levelId);
    if (!level) return;
    if (t.tile.kind === 'station') this.enterStation(level);
  }

  private showPrompt(t: Target | null): void {
    let text = '';
    if (t?.tile.kind === 'npc') text = 'E  Talk to the ops lead';
    else if (t) {
      const level = ALL_LEVELS.find((l) => l.id === t.tile.levelId)!;
      const levels = moduleOf(level).levels;
      const prev = levels[levels.indexOf(level) - 1];
      if (t.tile.kind === 'station') text = `E  ${t.tile.label} · ${level.title}${this.store.get(level.id).completed ? ' (solved)' : ''}`;
      else if (!this.unlocked(level.id)) text = `Locked. Solve ${this.labelOf(prev)} first.`;
    }
    this.hud.textContent = text;
    this.hud.hidden = text === '' || this.mode !== 'world';
  }

  private say(text: string): void {
    window.clearTimeout(this.toastTimer);
    this.toast.textContent = text;
    this.toast.hidden = false;
    this.toastTimer = window.setTimeout(() => { this.toast.hidden = true; }, 9000);
  }

  private setMode(mode: 'world' | 'station'): void {
    this.mode = mode;
    this.canvas.hidden = mode !== 'world';
    this.termHost.hidden = mode !== 'station';
    this.mapBtn.hidden = mode !== 'station';
    this.hud.hidden = true;
    if (mode === 'world') {
      this.game = null;
      this.term.blur();
      this.world.start();
    } else {
      this.world.stop();
      this.toast.hidden = true;
    }
  }

  private leaveStation(): void {
    if (this.mode !== 'station' || !this.game) return;
    const level = this.game.level;
    const solved = this.game.status === 'won';
    this.world.standAt(level.id);
    this.setMode('world');
    this.refresh();
    if (solved) {
      const next = this.nextInModule(level);
      this.say(`${next ? `Door ${this.labelOf(next)} unlocked. ` : ''}Intel: ${level.intel}`);
    }
  }

  // ------------------------------------------------------------------ station mode
  private enterStation(level: LevelMeta): void {
    this.world.standAt(level.id);
    this.setMode('station');
    this.replay = this.store.get(level.id).completed;
    this.game = createSession(level, {
      hint: () => this.hint(),
      mission: () => `${BOLD}${level.title}${OFF}\n\n${level.story}\n\n${YELLOW}Objective:${OFF} ${level.objective}\n`,
      levels: () => this.levelsText(),
      reset: () => this.resetLevel(),
      next: () => this.next(),
      exit: () => { setTimeout(() => this.leaveStation()); return ''; },
    });
    this.store.recordAttempt(level.id);
    this.editor = new LineEditor();
    this.term.reset();
    this.fit.fit();
    const m = moduleOf(level);
    this.term.write(
      `${BOLD}${m.place}${OFF} ${DIM}·${OFF} ${this.labelOf(level)}: ${BOLD}${level.title}${OFF}${this.replay ? ` ${DIM}(replay)${OFF}` : ''}\n` +
      `${YELLOW}Objective:${OFF} ${level.objective}\n` +
      `${DIM}Commands: ${OFF}help${DIM}, ${OFF}hint${DIM}, ${OFF}mission${DIM}, ${OFF}exit${DIM} (back to the map). Tab completes, ↑ recalls history.${OFF}\n\n`,
    );
    this.cursorRow = this.endRow = 0;
    this.redraw();
    this.refresh();
    requestAnimationFrame(() => { this.fit.fit(); this.term.focus(); });
  }

  private resetLevel(): string {
    const game = this.game!;
    const hints = game.hintsUsed; // hint penalties survive a reset
    game.reset();
    game.hintsUsed = hints;
    this.store.recordAttempt(game.level.id);
    queueMicrotask(() => this.refresh());
    return 'Level reset to its initial state.\n';
  }

  private next(): string {
    const game = this.game!;
    if (game.status !== 'won') return 'Solve this task first.\n';
    const next = this.nextInModule(game.level);
    if (!next) return `That was the last task in the ${moduleOf(game.level).place}. Type exit to return to the map.\n`;
    setTimeout(() => this.enterStation(next));
    return '';
  }

  private hint(): string {
    const hint = this.game!.nextHint();
    queueMicrotask(() => this.refresh());
    if (!hint) return 'No more hints: all three are shown in the mission panel.\n';
    return `${YELLOW}Hint ${hint.tier}/3${OFF} ${DIM}(-${hint.cost} points)${OFF}\n${hint.text}\n`;
  }

  private levelsText(): string {
    return MODULES.map((m) => `${BOLD}${m.place}${OFF} ${DIM}(${m.name})${OFF}\n` + m.levels.map((l) => {
      const p = this.store.get(l.id);
      const mark = p.completed ? `${GREEN}done${OFF}  ` : this.unlocked(l.id) ? `${CYAN}open${OFF}  ` : `${DIM}locked${OFF}`;
      return ` ${l === this.game?.level ? '>' : ' '} ${this.labelOf(l)} ${mark} ${l.title}${p.completed ? `${DIM}  best ${p.bestScore}${OFF}` : ''}`;
    }).join('\n')).join('\n') + '\n';
  }

  // ------------------------------------------------------------------ terminal I/O
  /** Repaint the prompt and the edit buffer, handling lines that wrap. */
  private redraw(): void {
    if (!this.game) return;
    const cols = this.term.cols;
    const p = this.game.prompt();
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
    if (this.modalOpen || this.mode !== 'station') return;
    for (const ev of this.editor.feed(data)) {
      if (!this.game) return;
      if (ev.type === 'change') this.redraw();
      else if (ev.type === 'submit') { this.leaveLine(); this.run(ev.line); this.redraw(); }
      else if (ev.type === 'interrupt') { this.term.write('^C'); this.leaveLine(); this.redraw(); }
      else if (ev.type === 'clear') { this.term.write('\x1b[H\x1b[2J\x1b[3J'); this.cursorRow = this.endRow = 0; this.redraw(); }
      else this.tab();
    }
  }

  private tab(): void {
    const c = this.game!.complete(this.editor.buffer, this.editor.cursor);
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
    const game = this.game!;
    const level = game.level;
    const r = game.exec(line, { tty: true, cols: this.term.cols });
    if (this.game !== game) return; // the command left the terminal (exit / next)
    let out = r.output;
    if (out !== '' && !out.endsWith('\n') && !out.endsWith('\x1b[3J')) out += '\n';
    if (r.wrongAnswer) out += `${RED}✗ Wrong answer.${OFF}\n`;
    if (r.justFailed) out += `${RED}✗ Level failed.${OFF} ${game.failMessage} Type ${BOLD}reset${OFF}.\n`;
    if (r.justWon) {
      const score = game.score();
      const res = this.store.recordWin(level.id, score, game.commandCount, game.hintsUsed);
      out += `${GREEN}✓ Solved.${OFF} Score ${BOLD}${score}${OFF}` +
        `${res.firstClear ? '' : res.newBest ? ' (new best)' : ` (best stays ${this.store.get(level.id).bestScore})`}.\n` +
        `${CYAN}Intel:${OFF} ${level.intel}\nType ${BOLD}exit${OFF} to return to the map.\n`;
      setTimeout(() => { if (this.game === game) this.showCard(level, true); }, 350);
    }
    this.term.write(out);
    this.refresh();
  }

  // ------------------------------------------------------------------ side panel
  private refresh(): void {
    this.summary.textContent = `${this.store.completedCount(ALL_IDS)}/${ALL_LEVELS.length} solved · ${this.store.totalScore(ALL_IDS)} pts`;
    if (this.mode === 'world' || !this.game) this.refreshWorldPanel();
    else this.refreshStationPanel(this.game);
  }

  private refreshWorldPanel(): void {
    const wings = MODULES.flatMap((m) => {
      const ids = idsOf(m);
      const done = this.store.completedCount(ids);
      const next = m.levels.find((l) => !this.store.get(l.id).completed);
      const last = [...m.levels].reverse().find((l) => this.store.get(l.id).completed);
      return [
        h('h3', {}, `${m.place} · ${m.name}`),
        h('div', { class: 'wing' },
          h('div', { class: 'bar', role: 'img', 'aria-label': `${done} of ${ids.length} solved` }, h('span', { style: `width:${(100 * done) / ids.length}%` })),
          h('p', { class: 'muted' }, `${done}/${ids.length} solved${next ? ` · next: ${this.labelOf(next)} ${next.title}` : ' · wing secured'}`),
          h('p', {}, last ? `Intel: ${last.intel}` : m.blurb),
        ),
      ];
    });
    this.panel.replaceChildren(
      h('p', { class: 'tag' }, 'Facility map'),
      h('h2', {}, 'Two wings, one incident'),
      h('p', { class: 'story' }, 'Walk to a terminal and press E. Each solved task unlocks the next door and gives a lead.'),
      ...wings,
      h('h3', {}, 'Controls'),
      h('dl', { class: 'stats' },
        h('dt', {}, 'Move'), h('dd', {}, 'WASD or arrow keys'),
        h('dt', {}, 'Interact'), h('dd', {}, 'E (or Enter)'),
        h('dt', {}, 'Leave terminal'), h('dd', {}, 'type exit'),
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', click: () => this.showBriefing() }, 'Briefing'),
        h('button', { class: 'btn', click: () => this.showLevelSelect() }, 'Levels'),
      ),
    );
  }

  private refreshStationPanel(game: Session): void {
    const level = game.level;
    const best = this.store.get(level.id);
    const won = game.status === 'won';
    const next = this.nextInModule(level);
    const write = (text: string): void => { this.term.write('\r\x1b[J' + text); this.cursorRow = this.endRow = 0; this.redraw(); this.term.focus(); };

    const hints = h('ol', { class: 'hints' }, ...level.hints.slice(0, game.hintsUsed).map((t) => h('li', {}, t)));
    const hintBtn = h('button', { class: 'btn', disabled: game.hintsUsed >= 3, click: () => write(this.hint()) },
      game.hintsUsed >= 3 ? 'All hints shown' : `Reveal hint ${game.hintsUsed + 1} (-${HINT_COSTS[game.hintsUsed]} pts)`);

    this.panel.replaceChildren(
      h('p', { class: 'tag' }, `${moduleOf(level).place} · ${this.labelOf(level)}`, this.replay ? h('span', { class: 'badge' }, 'replay') : ''),
      h('h2', {}, level.title),
      h('div', { class: 'story' }, ...level.story.trim().split(/\n+/).map((line) => h('p', {}, line.trim()))),
      h('div', { class: `objective ${won ? 'done' : game.status === 'failed' ? 'failed' : ''}` },
        h('strong', {}, won ? '✓ Solved' : game.status === 'failed' ? '✗ Failed: type reset' : 'Objective'),
        h('p', {}, level.objective)),
      won ? h('p', { class: 'intel' }, h('strong', {}, 'Intel '), level.intel) : '',
      h('h3', {}, 'Hints'),
      game.hintsUsed ? hints : h('p', { class: 'muted' }, 'Three hints: -10, -20, -30 points.'),
      hintBtn,
      h('h3', {}, 'Score'),
      h('dl', { class: 'stats' },
        h('dt', {}, 'Score'), h('dd', { class: 'score' }, String(game.score())),
        h('dt', {}, 'Commands'), h('dd', {}, `${game.commandCount} (+${PAR_BONUS} if ${game.par} or fewer)`),
        h('dt', {}, 'Best'), h('dd', {}, best.completed ? String(best.bestScore) : '-'),
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', click: () => write(this.resetLevel()) }, 'Reset level'),
        best.completed ? h('button', { class: 'btn', click: () => this.showCard(level, won) }, 'Concept card') : '',
        h('button', { class: `btn ${won ? 'primary' : ''}`, click: () => this.leaveStation() }, 'Back to map'),
        won && next ? h('button', { class: 'btn', click: () => this.enterStation(next) }, `Next: ${this.labelOf(next)}`) : '',
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
    if (this.mode === 'station') this.term.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  }

  private showBriefing(): void {
    this.openModal(
      h('p', { class: 'tag' }, 'Ops lead'),
      h('h2', {}, 'Briefing'),
      h('ul', { class: 'points' },
        h('li', {}, 'North wing, Server Room: web01, a Linux web server, was compromised. Work through terminals L1 to L8.'),
        h('li', {}, 'South wing, IT Office: the corp.example Active Directory domain needs hardening. Consoles A1 to A5.'),
        h('li', {}, 'Each solved task unlocks the next door in its wing and gives you a lead.'),
        h('li', {}, 'Move with WASD or the arrow keys. Press E at a terminal. Type exit to come back.'),
      ),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', click: () => this.closeModal() }, 'Start')),
    );
  }

  private showCard(level: LevelMeta, justPlayed: boolean): void {
    const card = level.conceptCard;
    const p = this.store.get(level.id);
    const game = justPlayed ? this.game : null;
    const next = this.nextInModule(level);
    const section = (title: string, points: string[]): HTMLElement =>
      h('section', {}, h('h3', {}, title), h('ul', { class: 'points' }, ...points.map((t) => h('li', {}, t))));
    const go = (fn: () => void) => () => { this.closeModal(); fn(); };
    let scoreLine: HTMLElement | string = '';
    if (game) {
      const hintCost = HINT_COSTS.slice(0, game.hintsUsed).reduce((a, b) => a + b, 0);
      scoreLine = h('p', { class: 'scoreline' },
        `Score ${game.score()} = ${BASE_SCORE} base${hintCost ? ` - ${hintCost} hints` : ''}${game.commandCount <= game.par ? ` + ${PAR_BONUS} efficiency bonus` : ''}`,
        h('span', { class: 'muted' }, `  ·  best ${p.bestScore}  ·  ${game.commandCount} ${game.commandCount === 1 ? 'command' : 'commands'}`));
    }
    this.openModal(
      h('p', { class: 'tag' }, `Concept card · ${moduleOf(level).place} ${this.labelOf(level)}`),
      h('h2', {}, level.title),
      scoreLine,
      h('p', { class: 'intel' }, h('strong', {}, 'Intel '), level.intel),
      section('Attack', card.attack),
      section('Detection', card.detection),
      section('Mitigation', card.mitigation),
      h('section', {}, h('h3', {}, 'Commands'),
        h('dl', { class: 'cmds' }, ...card.commands.flatMap((c) => [h('dt', {}, h('code', {}, c.cmd)), h('dd', {}, c.explain)]))),
      h('section', { class: 'two-col' },
        h('div', {}, h('h3', {}, 'Reference solution'), h('pre', {}, level.idealSolution.join('\n'))),
        game ? h('div', {}, h('h3', {}, 'Your commands'), h('pre', {}, game.commands.join('\n') || '(nothing)')) : '',
      ),
      h('div', { class: 'actions' },
        game ? h('button', { class: 'btn primary', click: go(() => this.leaveStation()) }, 'Back to map') : '',
        game && next ? h('button', { class: 'btn', click: go(() => this.enterStation(next)) }, `Next: ${this.labelOf(next)}`) : '',
        h('button', { class: 'btn', click: go(() => this.enterStation(level)) }, 'Replay'),
        h('button', { class: 'btn', click: () => this.closeModal() }, game ? 'Keep exploring' : 'Close'),
      ),
    );
  }

  private showLevelSelect(): void {
    const go = (fn: () => void) => () => { this.closeModal(); fn(); };
    const sections = MODULES.flatMap((m) => [
      h('h3', {}, `${m.place} · ${m.name}`),
      h('ol', { class: 'levels' }, ...m.levels.map((l, i) => {
        const p = this.store.get(l.id);
        const open = this.unlocked(l.id);
        return h('li', { class: `level ${p.completed ? 'done' : open ? 'open' : 'locked'}` },
          h('span', { class: 'num' }, p.completed ? '✓' : this.labelOf(l)),
          h('div', { class: 'info' },
            h('strong', {}, l.title),
            h('span', { class: 'muted' }, p.completed
              ? `best ${p.bestScore} · fewest commands ${p.bestCommands} · ${p.attempts} ${p.attempts === 1 ? 'attempt' : 'attempts'}`
              : open ? l.objective : `Solve ${this.labelOf(m.levels[i - 1])} to unlock`)),
          h('div', { class: 'actions' },
            p.completed ? h('button', { class: 'btn', click: () => this.showCard(l, false) }, 'Card') : '',
            h('button', { class: `btn ${!p.completed && open ? 'primary' : ''}`, disabled: !open, click: go(() => this.enterStation(l)) }, p.completed ? 'Replay' : 'Go'),
          ));
      })),
    ]);
    // Two clicks instead of window.confirm(), which is unavailable in sandboxed embeds.
    let armed = false;
    const resetBtn: HTMLButtonElement = h('button', {
      class: 'btn danger',
      click: () => {
        if (!armed) { armed = true; resetBtn.textContent = 'Click again to erase everything'; return; }
        this.store.reset();
        this.closeModal();
        if (this.mode === 'station') this.setMode('world');
        this.refresh();
      },
    }, 'Reset all progress');
    this.openModal(
      h('h2', {}, 'Levels'),
      h('p', { class: 'muted' }, `${this.store.completedCount(ALL_IDS)}/${ALL_LEVELS.length} solved · ${this.store.totalScore(ALL_IDS)} pts · "Go" takes you straight to the terminal`),
      ...sections,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', click: () => this.closeModal() }, 'Close'),
        resetBtn,
      ),
    );
  }
}
