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
  /** what the attack / weakness is */
  attack: string;
  /** how defenders detect it */
  detection: string;
  /** the real-world mitigation */
  mitigation: string;
  /** the exact commands used, each with a one-line explanation */
  commands: { cmd: string; explain: string }[];
}

export interface Level {
  id: string;
  title: string;
  story: string;
  /** the single goal, in one sentence */
  objective: string;
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
  hints: [string, string, string];
  conceptCard: ConceptCard;
  idealSolution: string[];
  /** other valid ways to solve the level; at least one is required */
  altSolutions: string[][];
  /** plausible-but-wrong command sequences that must NOT complete the level */
  wrongSolutions?: string[][];
}
