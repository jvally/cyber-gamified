import type { LevelMeta } from '../levels/types';
import type { Directory } from './directory';

export interface AdState { dir: Directory; submitted: string[]; history: string[] }

export interface AdLevel extends LevelMeta {
  module: 'ad';
  /** seconds since the epoch; the level's frozen clock */
  now: number;
  /** adjust the baseline corp.example directory for this level */
  setup(dir: Directory): void;
  goalCheck(state: AdState): boolean;
  failCheck?(state: AdState): string | null;
}
