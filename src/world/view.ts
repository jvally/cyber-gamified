// Canvas renderer and keyboard movement for the facility map. All art is drawn procedurally.
import { Dir, facing, Pos, Station, step, Target, Tile, tileAt, walkable, WorldMap } from './map';

export interface WorldCallbacks {
  unlocked(levelId: string): boolean;
  done(levelId: string): boolean;
  /** player pressed the interact key while facing something */
  interact(target: Target): void;
  /** the thing in front of the player changed (null = nothing) */
  prompt(target: Target | null): void;
}

const C = {
  bg: '#070a16', hall: '#131b30', hallAlt: '#16203a', linux: '#0f1d2c', linuxAlt: '#11222f', ad: '#1a1730', adAlt: '#1e1a38',
  wall: '#222c4c', wallTop: '#33416b', wallEdge: '#161d36',
  magenta: '#ff2fd0', lime: '#9fef00', cyan: '#2ee6ff', blue: '#3a7bff', dim: '#59668c', dark: '#0a0d1c', text: '#e6ecff',
  metal: '#2b3657', metalDark: '#1a2240', wood: '#5a4636', leaf: '#3fae5a', leafDark: '#2a7d43', pot: '#8a5a3c',
};

// 12x16 sprites. h hair, s skin, e eye, g top, p trousers, k shoes.
const DOWN = ['....hhhh....', '...hhhhhh...', '...hssssh...', '...sesses...', '...ssssss...', '....ssss....', '...gggggg...', '..gggggggg..', '..sggggggs..', '..sggggggs..', '...gggggg...', '...pppppp...'];
const UP = ['....hhhh....', '...hhhhhh...', '...hhhhhh...', '...hhhhhh...', '...shhhhs...', '....ssss....', '...gggggg...', '..gggggggg..', '..sggggggs..', '..sggggggs..', '...gggggg...', '...pppppp...'];
const SIDE = ['....hhhh....', '...hhhhhh...', '...hhhsss...', '...hhsses...', '...hsssss...', '....ssss....', '....ggggg...', '...gggggg...', '...ggggsg...', '...ggggsg...', '....ggggg...', '....ppppp...'];
const LEGS = [
  ['...pp..pp...', '...pp..pp...', '...kk..kk...'],
  ['...pp..pp...', '...kk..pp...', '.......kk...'],
  ['...pp..pp...', '...pp..kk...', '...kk.......'],
];
const SIDE_LEGS = [
  ['....pp.pp...', '....pp.pp...', '....kk.kk...'],
  ['....ppppp...', '...pp...pp..', '...kk...kk..'],
  ['....pppp....', '.....ppp....', '.....kkk....'],
];
type Palette = Record<string, string>;
const PLAYER: Palette = { h: '#1b2238', s: '#f0c39a', e: '#10131f', g: C.lime, p: '#27345e', k: '#0d1020' };
const NPC: Palette = { h: '#c9d2ec', s: '#d9a877', e: '#10131f', g: C.magenta, p: '#27345e', k: '#0d1020' };

const MOVE_MS = 135;
const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right',
};

export class WorldView {
  pos: Pos;
  dir: Dir = 'down';
  private ctx: CanvasRenderingContext2D;
  private held: Dir[] = [];
  private from: Pos | null = null;
  private moveStart = 0;
  private raf = 0;
  private running = false;
  private lastTarget: string | null = '';
  private tile = 40;
  private stationsById = new Map<string, Station>();

  constructor(private canvas: HTMLCanvasElement, private map: WorldMap, private cb: WorldCallbacks) {
    this.ctx = canvas.getContext('2d')!;
    this.pos = { ...map.spawn };
    for (const s of map.stations) this.stationsById.set(s.levelId, s);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.held = [];
    this.lastTarget = '';
    const loop = (t: number): void => {
      if (!this.running) return;
      this.update(t);
      this.draw(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop(): void { this.running = false; cancelAnimationFrame(this.raf); this.held = []; }

  /** Put the player in front of a level's terminal. */
  standAt(levelId: string): void {
    const s = this.stationsById.get(levelId);
    if (!s) return;
    this.pos = { ...s.stand };
    this.dir = s.face;
    this.from = null;
    this.lastTarget = '';
  }

  /** Returns true when the key was used (so the caller can preventDefault). */
  keyDown(key: string): boolean {
    const dir = KEY_DIRS[key];
    if (dir) {
      this.held = [dir, ...this.held.filter((d) => d !== dir)];
      return true;
    }
    if (key === 'e' || key === 'E' || key === 'Enter' || key === ' ') {
      const t = this.from ? null : facing(this.map, this.pos, this.dir);
      if (t) this.cb.interact(t);
      return true;
    }
    return false;
  }
  keyUp(key: string): void {
    const dir = KEY_DIRS[key];
    if (dir) this.held = this.held.filter((d) => d !== dir);
  }
  /** Tap or click: step toward the pointer, or interact when tapping the thing being faced. */
  pointer(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const cam = this.camera();
    const tx = Math.floor((clientX - rect.left + cam.x) / this.tile), ty = Math.floor((clientY - rect.top + cam.y) / this.tile);
    const t = facing(this.map, this.pos, this.dir);
    if (t && t.pos.x === tx && t.pos.y === ty) { this.cb.interact(t); return; }
    const dx = tx - this.pos.x, dy = ty - this.pos.y;
    if (dx === 0 && dy === 0) return;
    const dir: Dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    this.tryMove(dir, performance.now());
  }

  private tryMove(dir: Dir, now: number): void {
    if (this.from) return;
    this.dir = dir;
    const n = step(this.pos, dir);
    if (walkable(this.map, n.x, n.y, this.cb.unlocked)) {
      this.from = this.pos;
      this.pos = n;
      this.moveStart = now;
    }
  }

  private update(now: number): void {
    if (this.from && now - this.moveStart >= MOVE_MS) this.from = null;
    if (!this.from && this.held.length) this.tryMove(this.held[0], now);
    const t = this.from ? null : facing(this.map, this.pos, this.dir);
    const key = t ? `${t.pos.x},${t.pos.y}` : null;
    if (key !== this.lastTarget) { this.lastTarget = key; this.cb.prompt(t); }
  }

  private camera(): { x: number; y: number } {
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight, T = this.tile;
    const p = this.renderPos(performance.now());
    const mw = this.map.w * T, mh = this.map.h * T;
    const clamp = (v: number, size: number, view: number): number => (size <= view ? (size - view) / 2 : Math.max(0, Math.min(size - view, v)));
    return { x: clamp(p.x * T + T / 2 - cw / 2, mw, cw), y: clamp(p.y * T + T / 2 - ch / 2, mh, ch) };
  }
  private renderPos(now: number): Pos {
    if (!this.from) return this.pos;
    const k = Math.min(1, (now - this.moveStart) / MOVE_MS);
    return { x: this.from.x + (this.pos.x - this.from.x) * k, y: this.from.y + (this.pos.y - this.from.y) * k };
  }

  // ------------------------------------------------------------------ drawing
  private draw(now: number): void {
    const { canvas, ctx, map } = this;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (cw === 0 || ch === 0) return;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    this.tile = Math.max(26, Math.min(52, Math.floor(ch / map.h)));
    const T = this.tile;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, cw, ch);
    const cam = this.camera();
    ctx.translate(-Math.round(cam.x), -Math.round(cam.y));

    const x0 = Math.max(0, Math.floor(cam.x / T)), x1 = Math.min(map.w - 1, Math.ceil((cam.x + cw) / T));
    const y0 = Math.max(0, Math.floor(cam.y / T)), y1 = Math.min(map.h - 1, Math.ceil((cam.y + ch) / T));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.drawTile(tileAt(map, x, y)!, x, y, now);

    const p = this.renderPos(now);
    const frame = this.from ? 1 + (Math.floor((now - this.moveStart) / (MOVE_MS / 2)) % 2) : 0;
    this.sprite(p.x * T, p.y * T, this.dir, frame, PLAYER);

    const t = this.from ? null : facing(map, this.pos, this.dir);
    if (t && (t.tile.kind !== 'door' || !this.cb.unlocked(t.tile.levelId!))) this.keycap(p.x * T + T * 1.2, p.y * T + T * 0.3, t.tile.kind === 'door' ? '×' : 'E');
  }

  private rect(x: number, y: number, w: number, h: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(w), Math.ceil(h));
  }

  private floor(x: number, y: number, zone: Tile['zone'], gx: number, gy: number): void {
    const T = this.tile, alt = (gx + gy) % 2 === 0;
    this.rect(x, y, T, T, zone === 'linux' ? (alt ? C.linux : C.linuxAlt) : zone === 'ad' ? (alt ? C.ad : C.adAlt) : alt ? C.hall : C.hallAlt);
  }

  private statusColor(levelId: string): string {
    return this.cb.done(levelId) ? C.lime : this.cb.unlocked(levelId) ? C.magenta : C.dim;
  }

  private drawTile(t: Tile, gx: number, gy: number, now: number): void {
    const T = this.tile, x = gx * T, y = gy * T, u = T / 16;
    if (t.kind === 'wall' || t.kind === 'sign') {
      this.rect(x, y, T, T, C.wall);
      this.rect(x, y, T, u * 5, C.wallTop);
      this.rect(x, y + T - u, T, u, C.wallEdge);
      if (t.kind === 'sign') {
        const color = this.statusColor(t.levelId!);
        this.rect(x + u * 2, y + u * 6, u * 12, u * 7, C.dark);
        this.rect(x + u * 2, y + u * 6, u * 12, u, color);
        this.label(t.label!, x + T / 2, y + u * 10.2, u * 5.2, color);
      }
      return;
    }
    this.floor(x, y, t.zone, gx, gy);
    if (t.kind === 'door') {
      const open = this.cb.unlocked(t.levelId!);
      this.rect(x, y, u * 2, T, C.wallTop);
      this.rect(x + T - u * 2, y, u * 2, T, C.wallTop);
      if (!open) {
        this.rect(x + u * 2, y, u * 12, T, C.metalDark);
        for (let i = 0; i < 4; i++) this.rect(x + u * (3 + i * 3), y + u, u, T - u * 2, C.metal);
        this.rect(x + u * 6, y + u * 6, u * 4, u * 4, C.magenta);
        this.rect(x + u * 7, y + u * 7.5, u * 2, u * 1.5, C.dark);
      } else {
        this.rect(x + u * 2, y, u * 12, u, this.cb.done(t.levelId!) ? C.lime : C.magenta);
      }
    } else if (t.kind === 'station') {
      const color = this.statusColor(t.levelId!);
      const live = this.cb.unlocked(t.levelId!) && !this.cb.done(t.levelId!);
      const blink = live && Math.floor(now / 450) % 2 === 0;
      if (t.zone === 'linux') {
        this.rect(x + u, y, u * 14, T - u, C.metalDark);
        this.rect(x + u * 2, y + u, u * 12, u * 6, C.dark);
        this.rect(x + u * 3, y + u * 2, u * 6, u, color);
        this.rect(x + u * 3, y + u * 4, u * 4, u, live ? C.cyan : C.dim);
        for (let i = 0; i < 3; i++) this.rect(x + u * 2, y + u * (8 + i * 2), u * 12, u, C.metal);
        this.rect(x + u * 11, y + u * 12.5, u * 2, u * 2, blink || !live ? color : C.dark);
      } else {
        this.rect(x, y + u * 8, T, u * 6, C.wood);
        this.rect(x, y + u * 8, T, u, '#6d5644');
        this.rect(x + u * 3, y + u, u * 10, u * 7, C.metalDark);
        this.rect(x + u * 4, y + u * 2, u * 8, u * 5, C.dark);
        this.rect(x + u * 5, y + u * 3, u * 5, u, color);
        this.rect(x + u * 5, y + u * 5, u * 3, u, live ? C.cyan : C.dim);
        this.rect(x + u * 7, y + u * 8, u * 2, u, C.metal);
        this.rect(x + u * 12, y + u * 10, u * 2, u * 2, blink || !live ? color : C.dark);
      }
    } else if (t.kind === 'decor') {
      if (t.decor === 'rack') {
        this.rect(x + u, y, u * 14, T - u, C.metalDark);
        for (let i = 0; i < 6; i++) this.rect(x + u * 2, y + u * (1.5 + i * 2.2), u * 12, u, C.metal);
        this.rect(x + u * 3, y + u * 1.5, u, u, Math.floor(now / 700 + gx) % 3 ? C.cyan : C.dim);
        this.rect(x + u * 5, y + u * 5.9, u, u, C.blue);
      } else if (t.decor === 'plant') {
        this.rect(x + u * 5, y + u * 10, u * 6, u * 5, C.pot);
        this.rect(x + u * 4, y + u * 3, u * 8, u * 7, C.leafDark);
        this.rect(x + u * 5, y + u * 2, u * 3, u * 5, C.leaf);
        this.rect(x + u * 9, y + u * 5, u * 2, u * 3, C.leaf);
      } else if (t.decor === 'cabinet') {
        this.rect(x + u * 2, y + u, u * 12, T - u * 2, C.metal);
        for (let i = 0; i < 3; i++) { this.rect(x + u * 3, y + u * (2 + i * 4.3), u * 10, u * 3.4, C.metalDark); this.rect(x + u * 7, y + u * (3.2 + i * 4.3), u * 2, u, C.dim); }
      } else {
        this.rect(x + u * 2, y + u * 5, u * 12, u * 10, C.wood);
        this.rect(x + u * 2, y + u * 9, u * 12, u, '#3f3126');
        this.rect(x + u * 7.5, y + u * 5, u, u * 10, '#3f3126');
      }
    } else if (t.kind === 'npc') {
      this.sprite(x, y, 'down', 0, NPC);
    }
  }

  private sprite(x: number, y: number, dir: Dir, frame: number, pal: Palette): void {
    const T = this.tile, u = T / 16;
    const side = dir === 'left' || dir === 'right';
    const rows = [...(dir === 'up' ? UP : side ? SIDE : DOWN), ...(side ? SIDE_LEGS : LEGS)[frame]];
    const ox = x + (T - 12 * u) / 2, oy = y + u * 0.5 - (frame ? u * 0.5 : 0);
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    this.ctx.fillRect(Math.round(x + u * 3), Math.round(y + u * 14.2), Math.ceil(u * 10), Math.ceil(u * 1.6));
    rows.forEach((row, r) => {
      for (let c = 0; c < 12; c++) {
        const ch = row[dir === 'left' ? 11 - c : c];
        if (ch !== '.') this.rect(ox + c * u, oy + r * u, u, u, pal[ch]);
      }
    });
  }

  private label(text: string, cx: number, cy: number, size: number, color: string): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.font = `700 ${Math.max(8, Math.round(size))}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, Math.round(cx), Math.round(cy));
  }

  private keycap(cx: number, cy: number, text: string): void {
    const s = Math.max(16, this.tile * 0.46);
    this.rect(cx - s / 2, cy - s / 2, s, s, C.dark);
    this.rect(cx - s / 2, cy - s / 2, s, 2, text === 'E' ? C.lime : C.magenta);
    this.label(text, cx, cy + 1, s * 0.62, text === 'E' ? C.lime : C.magenta);
  }
}
