import type { VFS } from '../vfs/vfs';
import type { ProcessTable } from '../sim/processes';
import type { UserDb } from '../sim/users';

/** Hooks the UI/level engine may provide; the shell works without them. */
export interface GameHooks {
  hint?(): string;
  mission?(): string;
  levels?(): string;
  reset?(): string;
  next?(): string;
}

export interface GameState {
  vfs: VFS;
  procs: ProcessTable;
  users: UserDb;
  env: Record<string, string>;
  cwd: string;
  user: string;
  hostname: string;
  tty: string;
  shellPid: number;
  submitted: string[];
  history: string[];
  lastExit: number;
  game?: GameHooks;
}
