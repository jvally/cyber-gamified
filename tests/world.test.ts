import { describe, expect, it } from 'vitest';
import { buildWorld, facing, reachableStations, step, tileAt, walkable } from '../src/world/map';
import { MODULES } from '../src/levels/index';
import { ProgressStore } from '../src/progress/store';

const map = buildWorld(MODULES);
const ids = (m: number): string[] => MODULES[m].levels.map((l) => l.id);
const all = (): boolean => true, none = (): boolean => false;

describe('facility map', () => {
  it('has one terminal, door and sign per level', () => {
    const count = (kind: string): number => map.tiles.filter((t) => t.kind === kind).length;
    expect(map.stations.map((s) => s.levelId)).toEqual([...ids(0), ...ids(1)]);
    expect([count('station'), count('door'), count('sign'), count('npc')]).toEqual([13, 13, 13, 1]);
    expect(map.stations.map((s) => s.label)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'A1', 'A2', 'A3', 'A4', 'A5']);
  });
  it('is enclosed by walls and the spawn is on open floor', () => {
    for (let x = 0; x < map.w; x++) for (const y of [0, map.h - 1]) expect(tileAt(map, x, y)!.kind).toBe('wall');
    for (let y = 0; y < map.h; y++) for (const x of [0, map.w - 1]) expect(tileAt(map, x, y)!.kind).toBe('wall');
    expect(tileAt(map, map.spawn.x, map.spawn.y)!.kind).toBe('floor');
    expect(tileAt(map, -1, 0)).toBeUndefined();
    expect(walkable(map, -1, 0, all)).toBe(false);
  });
  it('each terminal has a free tile in front of it, facing the terminal', () => {
    for (const s of map.stations) {
      expect(tileAt(map, s.stand.x, s.stand.y)!.kind).toBe('floor');
      expect(step(s.stand, s.face)).toEqual(s.pos);
      expect(facing(map, s.stand, s.face)?.tile.levelId).toBe(s.levelId);
      expect(tileAt(map, s.door.x, s.door.y)).toMatchObject({ kind: 'door', levelId: s.levelId });
    }
  });
  it('doors gate the rooms', () => {
    expect(reachableStations(map, none)).toEqual([]);
    expect(reachableStations(map, all)).toHaveLength(13);
    expect(reachableStations(map, (id) => id === 'top-attacker')).toEqual(['top-attacker']);
    const door = map.stations[0].door;
    expect([walkable(map, door.x, door.y, none), walkable(map, door.x, door.y, all)]).toEqual([false, true]);
  });
  it('unlocking follows progress: first task of each wing, then one more per solved task', () => {
    const store = new ProgressStore(null);
    const unlocked = (id: string): boolean => {
      const m = MODULES.find((mod) => mod.levels.some((l) => l.id === id))!;
      const list = m.levels.map((l) => l.id);
      return store.isUnlocked(list, list.indexOf(id));
    };
    expect(reachableStations(map, unlocked)).toEqual(['leaked-env', 'ad-account-recovery']);
    store.recordWin('leaked-env', 100, 3, 0);
    store.recordWin('ad-account-recovery', 100, 3, 0);
    store.recordWin('ad-domain-admins', 100, 2, 0);
    expect(reachableStations(map, unlocked)).toEqual(['leaked-env', 'failed-logins', 'ad-account-recovery', 'ad-domain-admins', 'ad-stale-account']);
  });
  it('facing reports doors and the NPC, and nothing for plain floor or walls', () => {
    expect(facing(map, { x: map.npc.x, y: map.npc.y + 1 }, 'up')?.tile.kind).toBe('npc');
    expect(facing(map, map.spawn, 'down')).toBeNull();
    const d = map.stations[8].door;
    expect(facing(map, { x: d.x, y: d.y - 1 }, 'down')?.tile.kind).toBe('door');
    expect(facing(map, { x: 2, y: 6 }, 'up')).toBeNull();
  });
});
