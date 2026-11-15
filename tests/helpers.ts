import { baseFiles, baseProcs, buildState, at } from '../src/levels/builders';
import type { FileSpec } from '../src/levels/types';
import type { ProcSpec } from '../src/sim/processes';
import { Shell, RunResult } from '../src/shell/shell';
import type { GameState } from '../src/shell/state';

export const NOW = at('2026-11-15T09:00:00Z');

export interface Box { sh: Shell; state: GameState; run(line: string): RunResult; out(line: string): string }

export function box(files: FileSpec[] = [], procs: ProcSpec[] = [], user = 'analyst'): Box {
  const state = buildState({ now: NOW, files: [...baseFiles(NOW), ...files], procs: [...baseProcs(), ...procs], user });
  const sh = new Shell(state);
  return { sh, state, run: (l) => sh.run(l), out: (l) => sh.run(l).output };
}
