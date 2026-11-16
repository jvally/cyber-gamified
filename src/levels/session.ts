// Module-independent level session: hints, scoring, win/fail tracking. Each module (Linux shell,
// Active Directory console) supplies its own machine and interpreter by subclassing.
import type { GameHooks } from '../shell/state';
import type { Completion, LevelMeta } from './types';

export const BASE_SCORE = 100;
export const HINT_COSTS = [10, 20, 30] as const;
export const PAR_BONUS = 10;
export const MIN_SCORE = 10;
/** Commands that never count towards the command total. */
const META = new Set(['help', 'man', 'hint', 'mission', 'levels', 'clear', 'cls', 'history', 'reset', 'next', 'exit', 'get-help']);

export type Status = 'playing' | 'won' | 'failed';
export interface RunOptions { tty?: boolean; cols?: number }
export interface ExecResult {
  output: string;
  code: number;
  status: Status;
  justWon: boolean;
  justFailed: boolean;
  wrongAnswer: boolean;
}

export abstract class Session<L extends LevelMeta = LevelMeta> {
  status: Status = 'playing';
  failMessage: string | null = null;
  hintsUsed = 0;
  commandCount = 0;
  commands: string[] = [];

  constructor(public level: L, protected hooks: GameHooks = {}) {}

  /** (Re)create the simulated machine from the level definition. */
  protected abstract build(): void;
  protected abstract runLine(line: string, opts: RunOptions): { output: string; code: number };
  protected abstract goalMet(): boolean;
  protected abstract failure(): string | null;
  protected abstract submissionCount(): number;
  abstract prompt(): { text: string; length: number };
  abstract complete(line: string, cursor: number): Completion;

  reset(): void {
    this.build();
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

  exec(line: string, opts: RunOptions = {}): ExecResult {
    const first = (line.trim().split(/\s+/)[0] ?? '').toLowerCase();
    const meta = META.has(first);
    const base = { justWon: false, justFailed: false, wrongAnswer: false };
    if (line.trim() === '') return { output: '', code: 0, status: this.status, ...base };
    if (this.status === 'failed' && !meta) {
      return { output: 'Level is in a failed state. Type `reset`.\n', code: 1, status: this.status, ...base };
    }
    const before = this.submissionCount();
    const res = this.runLine(line, opts);
    if (!meta) { this.commandCount++; this.commands.push(line.trim()); }
    const out: ExecResult = { output: res.output, code: res.code, status: this.status, ...base };
    if (this.status !== 'playing') return out;
    const fail = this.failure();
    if (fail) {
      this.status = out.status = 'failed';
      this.failMessage = fail;
      out.justFailed = true;
    } else if (this.goalMet()) {
      this.status = out.status = 'won';
      out.justWon = true;
    } else if (this.submissionCount() > before) {
      out.wrongAnswer = true;
    }
    return out;
  }
}
