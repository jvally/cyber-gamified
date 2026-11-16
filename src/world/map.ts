// The facility map: pure data and rules (no rendering), so movement and unlocking can be unit tested.
//
// Layout: a central corridor. Linux server rooms line the north side, Active Directory offices the
// south side. Every room has one door onto the corridor and one terminal inside.

export type Dir = 'up' | 'down' | 'left' | 'right';
export type Zone = 'hall' | 'linux' | 'ad';
export type Decor = 'rack' | 'plant' | 'cabinet' | 'crate';
export interface Pos { x: number; y: number }
export interface Tile {
  kind: 'wall' | 'floor' | 'door' | 'station' | 'decor' | 'npc' | 'sign';
  zone: Zone;
  /** level a door or terminal belongs to */
  levelId?: string;
  /** short code shown in the world, e.g. L3 or A2 */
  label?: string;
  decor?: Decor;
}
export interface Station { levelId: string; label: string; zone: Zone; pos: Pos; /** where the player stands to use it */ stand: Pos; face: Dir; door: Pos }
export interface WorldMap { w: number; h: number; tiles: Tile[]; spawn: Pos; npc: Pos; stations: Station[] }
export interface ModuleSpec { id: 'linux' | 'ad'; levels: { id: string }[] }

const LINUX_PITCH = 6, AD_PITCH = 8;
const HALL_TOP = 6, HALL_BOTTOM = 9;

export function buildWorld(modules: ModuleSpec[]): WorldMap {
  const linux = modules.find((m) => m.id === 'linux')?.levels ?? [];
  const ad = modules.find((m) => m.id === 'ad')?.levels ?? [];
  const w = Math.max(LINUX_PITCH * linux.length + 1, AD_PITCH * ad.length + 1, 25);
  const h = 16;
  const zoneOf = (y: number): Zone => (y < HALL_TOP ? 'linux' : y > HALL_BOTTOM ? 'ad' : 'hall');
  const tiles: Tile[] = Array.from({ length: w * h }, (_, i) => ({ kind: 'wall', zone: zoneOf(Math.floor(i / w)) }));
  const set = (x: number, y: number, t: Partial<Tile>): void => { tiles[y * w + x] = { ...tiles[y * w + x], ...t }; };
  const floor = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, { kind: 'floor' });
  };
  const stations: Station[] = [];

  floor(1, HALL_TOP, w - 2, HALL_BOTTOM);
  for (const [x, y] of [[1, HALL_TOP], [w - 2, HALL_TOP], [1, HALL_BOTTOM], [w - 2, HALL_BOTTOM]]) set(x, y, { kind: 'decor', decor: 'plant' });

  const linuxOff = Math.floor((w - (LINUX_PITCH * linux.length + 1)) / 2);
  linux.forEach((lvl, k) => {
    const x0 = linuxOff + LINUX_PITCH * k + 1, cx = x0 + 2, label = `L${k + 1}`;
    floor(x0, 1, x0 + 4, 4);
    set(cx, 5, { kind: 'door', levelId: lvl.id, label });
    set(cx + 1, 5, { kind: 'sign', levelId: lvl.id, label });
    set(cx, 1, { kind: 'station', levelId: lvl.id, label });
    set(x0, 1, { kind: 'decor', decor: 'rack' });
    set(x0 + 4, 1, { kind: 'decor', decor: 'rack' });
    if (k % 2 === 1) set(x0, 4, { kind: 'decor', decor: 'crate' });
    stations.push({ levelId: lvl.id, label, zone: 'linux', pos: { x: cx, y: 1 }, stand: { x: cx, y: 2 }, face: 'up', door: { x: cx, y: 5 } });
  });

  const adOff = Math.floor((w - (AD_PITCH * ad.length + 1)) / 2);
  ad.forEach((lvl, k) => {
    const x0 = adOff + AD_PITCH * k + 1, cx = x0 + 3, label = `A${k + 1}`;
    floor(x0, 11, x0 + 6, 14);
    set(cx, 10, { kind: 'door', levelId: lvl.id, label });
    set(cx + 1, 10, { kind: 'sign', levelId: lvl.id, label });
    set(cx, 14, { kind: 'station', levelId: lvl.id, label });
    set(x0, 14, { kind: 'decor', decor: 'cabinet' });
    set(x0 + 6, 14, { kind: 'decor', decor: 'plant' });
    if (k % 2 === 0) set(x0 + 6, 11, { kind: 'decor', decor: 'cabinet' });
    stations.push({ levelId: lvl.id, label, zone: 'ad', pos: { x: cx, y: 14 }, stand: { x: cx, y: 13 }, face: 'down', door: { x: cx, y: 10 } });
  });

  // the ops lead stands against the north wall of the corridor, on a tile that is not in front of a door
  const mid = Math.floor(w / 2);
  let nx = mid;
  while (tiles[5 * w + nx].kind === 'door' || tiles[(HALL_BOTTOM + 1) * w + nx].kind === 'door') nx++;
  set(nx, HALL_TOP, { kind: 'npc' });
  return { w, h, tiles, spawn: { x: nx, y: HALL_TOP + 2 }, npc: { x: nx, y: HALL_TOP }, stations };
}

export const tileAt = (map: WorldMap, x: number, y: number): Tile | undefined =>
  (x < 0 || y < 0 || x >= map.w || y >= map.h ? undefined : map.tiles[y * map.w + x]);

export const step = (p: Pos, d: Dir): Pos =>
  (d === 'up' ? { x: p.x, y: p.y - 1 } : d === 'down' ? { x: p.x, y: p.y + 1 } : d === 'left' ? { x: p.x - 1, y: p.y } : { x: p.x + 1, y: p.y });

/** Can the player stand on this tile? Doors open once their level is unlocked. */
export function walkable(map: WorldMap, x: number, y: number, unlocked: (levelId: string) => boolean): boolean {
  const t = tileAt(map, x, y);
  if (!t) return false;
  if (t.kind === 'floor') return true;
  return t.kind === 'door' && unlocked(t.levelId!);
}

export interface Target { tile: Tile; pos: Pos }
/** The thing the player is facing, if it can be interacted with. */
export function facing(map: WorldMap, pos: Pos, dir: Dir): Target | null {
  const p = step(pos, dir);
  const tile = tileAt(map, p.x, p.y);
  return tile && (tile.kind === 'station' || tile.kind === 'door' || tile.kind === 'npc') ? { tile, pos: p } : null;
}

/** Level ids whose terminal can be walked to from the spawn point. */
export function reachableStations(map: WorldMap, unlocked: (levelId: string) => boolean): string[] {
  const seen = new Set<number>([map.spawn.y * map.w + map.spawn.x]);
  const queue: Pos[] = [map.spawn];
  while (queue.length) {
    const p = queue.shift()!;
    for (const d of ['up', 'down', 'left', 'right'] as Dir[]) {
      const n = step(p, d), key = n.y * map.w + n.x;
      if (!seen.has(key) && walkable(map, n.x, n.y, unlocked)) { seen.add(key); queue.push(n); }
    }
  }
  return map.stations.filter((s) => seen.has(s.stand.y * map.w + s.stand.x)).map((s) => s.levelId);
}
