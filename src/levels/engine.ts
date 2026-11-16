// Linux module session: a level's simulated machine plus the bash-like shell.
import { Shell } from '../shell/shell';
import type { GameHooks, GameState } from '../shell/state';
import { complete } from '../ui/completion';
import { buildState } from './builders';
import { ExecResult, RunOptions, Session } from './session';
import type { Completion, Level, LevelMeta } from './types';
import { AdGame } from '../ad/session';
import type { AdLevel } from '../ad/types';

export * from './session';

export const buildLevelState = (level: Level): GameState => buildState({
  now: level.now, files: level.initialFS, procs: level.initialProcesses,
  user: level.user, cwd: level.cwd, hostname: level.hostname,
});

/** The most recent `submit` answer, trimmed. */
export const lastAnswer = (state: { submitted: string[] }): string | undefined =>
  state.submitted[state.submitted.length - 1]?.trim();

export class Game extends Session<Level> {
  declare state: GameState;
  declare shell: Shell;

  constructor(level: Level, hooks: GameHooks = {}) {
    super(level, hooks);
    this.reset();
  }

  protected build(): void {
    this.state = buildLevelState(this.level);
    this.state.game = this.hooks;
    this.shell = new Shell(this.state);
  }
  protected runLine(line: string, opts: RunOptions): { output: string; code: number } { return this.shell.run(line, opts); }
  protected goalMet(): boolean { return this.level.goalCheck(this.state); }
  protected failure(): string | null { return this.level.failCheck?.(this.state) ?? null; }
  protected submissionCount(): number { return this.state.submitted.length; }

  prompt(): { text: string; length: number } {
    const { state } = this;
    const home = state.env.HOME;
    const cwd = state.cwd === home ? '~' : state.cwd.startsWith(home + '/') ? '~' + state.cwd.slice(home.length) : state.cwd;
    return {
      text: `\x1b[1;32m${state.user}@${state.hostname}\x1b[0m:\x1b[1;34m${cwd}\x1b[0m$ `,
      length: `${state.user}@${state.hostname}:${cwd}$ `.length,
    };
  }
  complete(line: string, cursor: number): Completion { return complete(line, cursor, this.state, this.shell.commands); }
}

/** Create the right kind of session for a level. */
export function createSession(level: LevelMeta, hooks: GameHooks = {}): Session {
  return level.module === 'ad' ? new AdGame(level as AdLevel, hooks) : new Game(level as Level, hooks);
}

/** Run a list of commands through a fresh session. Used by tests. */
export function runSolution<L extends LevelMeta>(level: L, commands: string[]): { game: L extends Level ? Game : Session; results: ExecResult[] } {
  const game = createSession(level);
  const results = commands.map((c) => game.exec(c));
  return { game: game as L extends Level ? Game : Session, results };
}
