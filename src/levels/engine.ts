// Level engine: builds a fresh simulated machine for a level, runs commands, and tracks win/fail/score.
import { Shell, RunOpts } from '../shell/shell';
import type { GameHooks, GameState } from '../shell/state';
import { buildState } from './builders';
import type { Level } from './types';

export const BASE_SCORE = 100;
export const HINT_COSTS = [10, 20, 30] as const;
export const PAR_BONUS = 10;
export const MIN_SCORE = 10;
/** Commands that never count towards the command total. */
const META = new Set(['help', 'man', 'hint', 'mission', 'levels', 'clear', 'history', 'reset', 'next']);

export type Status = 'playing' | 'won' | 'failed';
export interface ExecResult {
  output: string;
  code: number;
  status: Status;
  justWon: boolean;
  justFailed: boolean;
  wrongAnswer: boolean;
}

export const buildLevelState = (level: Level): GameState => buildState({
  now: level.now, files: level.initialFS, procs: level.initialProcesses,
  user: level.user, cwd: level.cwd, hostname: level.hostname,
});

/** The most recent `submit` answer, trimmed. */
export const lastAnswer = (state: GameState): string | undefined => state.submitted[state.submitted.length - 1]?.trim();

export class Game {
  state!: GameState;
  shell!: Shell;
  status: Status = 'playing';
  failMessage: string | null = null;
  hintsUsed = 0;
  commandCount = 0;
  commands: string[] = [];

  constructor(public level: Level, private hooks: GameHooks = {}) {
    this.reset();
  }

  reset(): void {
    this.state = buildLevelState(this.level);
    this.state.game = this.hooks;
    this.shell = new Shell(this.state);
    this.status = 'playing';
    this.failMessage = null;
    this.hintsUsed = 0;
    this.commandCount = 0;
    this.commands = [];
  }

  /** Commands allowed for the par bonus. */
  get par(): number { return this.level.idealSolution.length + 2; }

  score(): number {
    const hints = HINT_COSTS.slice(0, this.hintsUsed).reduce((a, b) => a + b, 0);
    const bonus = this.commandCount <= this.par ? PAR_BONUS : 0;
    return Math.max(MIN_SCORE, BASE_SCORE - hints + bonus);
  }

  /** Reveal the next hint tier, or null when all three are used. */
  nextHint(): { tier: number; text: string; cost: number } | null {
    if (this.hintsUsed >= this.level.hints.length) return null;
    const tier = this.hintsUsed++;
    return { tier: tier + 1, text: this.level.hints[tier], cost: HINT_COSTS[tier] };
  }

  exec(line: string, opts: RunOpts = {}): ExecResult {
    const first = line.trim().split(/\s+/)[0] ?? '';
    const meta = META.has(first);
    const base = { justWon: false, justFailed: false, wrongAnswer: false };
    if (line.trim() === '') return { output: '', code: 0, status: this.status, ...base };
    if (this.status === 'failed' && !meta) {
      return { output: 'This level is in a failed state. Type `reset` to start it again.\n', code: 1, status: this.status, ...base };
    }
    const before = this.state.submitted.length;
    const res = this.shell.run(line, opts);
    if (!meta) { this.commandCount++; this.commands.push(line.trim()); }
    const out: ExecResult = { output: res.output, code: res.code, status: this.status, ...base };
    if (this.status !== 'playing') return out;
    const fail = this.level.failCheck?.(this.state) ?? null;
    if (fail) {
      this.status = out.status = 'failed';
      this.failMessage = fail;
      out.justFailed = true;
    } else if (this.level.goalCheck(this.state)) {
      this.status = out.status = 'won';
      out.justWon = true;
    } else if (this.state.submitted.length > before) {
      out.wrongAnswer = true;
    }
    return out;
  }
}

/** Run a list of commands through a fresh game. Used by tests and by replay. */
export function runSolution(level: Level, commands: string[]): { game: Game; results: ExecResult[] } {
  const game = new Game(level);
  const results = commands.map((c) => game.exec(c));
  return { game, results };
}
