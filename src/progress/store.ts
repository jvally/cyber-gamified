// Progress persistence. Storage is injected so this is testable without a browser.

export interface LevelProgress {
  completed: boolean;
  bestScore: number;
  attempts: number;
  /** fewest commands used in a winning run */
  bestCommands: number | null;
  /** hints used in the best-scoring run */
  hintsUsed: number | null;
}
export interface Progress { version: 1; levels: Record<string, LevelProgress> }
export interface KV { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export const STORAGE_KEY = 'shellshock:v1';
const blank = (): LevelProgress => ({ completed: false, bestScore: 0, attempts: 0, bestCommands: null, hintsUsed: null });
const int = (v: unknown, fallback: number | null): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;

/** Parse stored JSON defensively: anything malformed is dropped rather than trusted. */
export function parseProgress(raw: string | null): Progress {
  const empty: Progress = { version: 1, levels: {} };
  if (!raw) return empty;
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return empty;
    const d = data as { version?: unknown; levels?: unknown };
    if (d.version !== 1 || typeof d.levels !== 'object' || d.levels === null || Array.isArray(d.levels)) return empty;
    for (const [id, v] of Object.entries(d.levels as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue;
      const p = v as Record<string, unknown>;
      empty.levels[id] = {
        completed: p.completed === true,
        bestScore: int(p.bestScore, 0)!,
        attempts: int(p.attempts, 0)!,
        bestCommands: int(p.bestCommands, null),
        hintsUsed: int(p.hintsUsed, null),
      };
    }
    return empty;
  } catch {
    return empty;
  }
}

export class ProgressStore {
  data: Progress;
  constructor(private storage: KV | null, private key = STORAGE_KEY) {
    let raw: string | null = null;
    try { raw = storage?.getItem(key) ?? null; } catch { /* storage blocked */ }
    this.data = parseProgress(raw);
  }

  private save(): void {
    try { this.storage?.setItem(this.key, JSON.stringify(this.data)); } catch { /* quota or private mode */ }
  }
  get(id: string): LevelProgress { return this.data.levels[id] ?? blank(); }

  recordAttempt(id: string): void {
    const p = (this.data.levels[id] ??= blank());
    p.attempts++;
    this.save();
  }

  /** Record a win. Replays can raise the best score but never lower it. */
  recordWin(id: string, score: number, commands: number, hints: number): { newBest: boolean; firstClear: boolean } {
    const p = (this.data.levels[id] ??= blank());
    const firstClear = !p.completed;
    const newBest = firstClear || score > p.bestScore;
    p.completed = true;
    if (newBest) { p.bestScore = score; p.hintsUsed = hints; }
    if (p.bestCommands === null || commands < p.bestCommands) p.bestCommands = commands;
    this.save();
    return { newBest, firstClear };
  }

  /** Levels unlock in order: the first is always open, the rest need the previous one completed. */
  isUnlocked(ids: string[], index: number): boolean {
    return index === 0 || this.get(ids[index - 1]).completed;
  }
  /** Index of the first level not yet completed (or the last level when all are done). */
  currentIndex(ids: string[]): number {
    const i = ids.findIndex((id) => !this.get(id).completed);
    return i < 0 ? ids.length - 1 : i;
  }
  totalScore(ids: string[]): number { return ids.reduce((s, id) => s + this.get(id).bestScore, 0); }
  completedCount(ids: string[]): number { return ids.filter((id) => this.get(id).completed).length; }

  reset(): void {
    this.data = { version: 1, levels: {} };
    try { this.storage?.removeItem(this.key); } catch { /* ignore */ }
  }
}
