import type { ProcSpec } from '../sim/processes';
import type { GameState } from '../shell/state';

export interface FileSpec {
  path: string;
  content?: string;
  dir?: boolean;
  mode?: number;
  owner?: string;
  group?: string;
  /** seconds since the epoch */
  mtime?: number;
}

export interface ConceptCard {
  /** what the attack / weakness is: short bullet points */
  attack: string[];
  /** how defenders detect it */
  detection: string[];
  /** the real-world mitigation */
  mitigation: string[];
  /** the exact commands used, each with a one-line explanation */
  commands: { cmd: string; explain: string }[];
}

export interface Completion { line: string; cursor: number; candidates: string[] }

/** What every level has, whichever module it belongs to. */
export interface LevelMeta {
  id: string;
  /** which simulated environment the level runs in */
  module: 'linux' | 'ad';
  title: string;
  story: string;
  /** the single goal, in one sentence */
  objective: string;
  hints: [string, string, string];
  conceptCard: ConceptCard;
  /** one line of intel revealed on completion: the lead that points to the next task */
  intel: string;
  idealSolution: string[];
  /** other valid ways to solve the level; at least one is required */
  altSolutions: string[][];
  /** plausible-but-wrong command sequences that must NOT complete the level */
  wrongSolutions?: string[][];
}

export interface Level extends LevelMeta {
  module: 'linux';
  /** seconds since the epoch; the level's frozen clock */
  now: number;
  user?: string;
  cwd?: string;
  hostname?: string;
  initialFS: FileSpec[];
  initialProcesses: ProcSpec[];
  goalCheck(state: GameState): boolean;
  /** returns a message when the player has broken something beyond the scope of the goal */
  failCheck?(state: GameState): string | null;
}
