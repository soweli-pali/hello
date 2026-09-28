// What a body sees, as a small PNG: the tiles in sight, blocks and roofs, things on the ground, animals and
// other bodies drawn as they look in the viewer. No dependencies: a tiny rasteriser and PNG writer.
import { deflateSync, crc32 } from 'node:zlib';
import type { World, Agent } from './world.ts';
import '../viewer/critters.js';
const Critters = (globalThis as any).Critters;

// ---- a minimal 2D canvas: solid fills of rectangles and polygons, with alpha ----
class Raster {
  w: number; h: number; px: Uint8Array; fillStyle = '#000'; path: number[][] = []; cur: number[] = [];
  constructor(w: number, h: number) { this.w = w; this.h = h; this.px = new Uint8Array(w * h * 4); }
  rgba(): [number, number, number, number] {
    const s = this.fillStyle.trim();
    if (s[0] === '#') { const x = s.length === 4 ? s.slice(1).split('').map(c => c + c).join('') : s.slice(1, 7); return [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16)).concat(255) as any; }
    const n = (s.match(/[\d.]+/g) ?? []).map(Number);
    if (s.startsWith('rgb')) return [n[0], n[1], n[2], Math.round((n[3] ?? 1) * 255)];
    if (s.startsWith('hsl')) { // hsl(h s% l%) or hsl(h, s%, l%)
      const [h, sat, l] = [n[0] / 360, n[1] / 100, n[2] / 100], q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q;
      const f = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
      return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(v => Math.round(v * 255)).concat(Math.round((n[3] ?? 1) * 255)) as any;
    }
    return [0, 0, 0, 255];
  }
  plot(x: number, y: number, c: number[]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; const i = (y * this.w + x) * 4, a = c[3] / 255;
    for (let k = 0; k < 3; k++) this.px[i + k] = Math.round(c[k] * a + this.px[i + k] * (1 - a)); this.px[i + 3] = 255;
  }
  fillRect(x: number, y: number, w: number, h: number) {
    const c = this.rgba(); for (let j = Math.round(y); j < Math.round(y + h); j++) for (let i = Math.round(x); i < Math.round(x + w); i++) this.plot(i, j, c);
  }
  beginPath() { this.path = []; this.cur = []; }
  moveTo(x: number, y: number) { if (this.cur.length) this.path.push(this.cur); this.cur = [x, y]; }
  lineTo(x: number, y: number) { this.cur.push(x, y); }
  ellipse(cx: number, cy: number, rx: number, ry: number) { if (this.cur.length) this.path.push(this.cur); const p: number[] = []; for (let k = 0; k < 28; k++) { const a = k / 28 * Math.PI * 2; p.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry); } this.path.push(p); this.cur = []; }
  arc(cx: number, cy: number, r: number) { this.ellipse(cx, cy, r, r); }
  fill() {
    if (this.cur.length) { this.path.push(this.cur); this.cur = []; }
    const c = this.rgba(), polys = this.path.filter(p => p.length >= 6); if (!polys.length) return;
    let y0 = Infinity, y1 = -Infinity; for (const p of polys) for (let k = 1; k < p.length; k += 2) { y0 = Math.min(y0, p[k]); y1 = Math.max(y1, p[k]); }
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(this.h - 1, Math.ceil(y1)); y++) { // even-odd scanlines at pixel centres
      const yc = y + 0.5, xs: number[] = [];
      for (const p of polys) for (let k = 0; k < p.length; k += 2) {
        const ax = p[k], ay = p[k + 1], bx = p[(k + 2) % p.length], by = p[(k + 3) % p.length];
        if ((ay <= yc) !== (by <= yc)) xs.push(ax + (yc - ay) / (by - ay) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) this.plot(x, y, c);
    }
  }
  png(): Buffer {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) for (let k = 0; k < 3; k++) raw[y * (this.w * 3 + 1) + 1 + x * 3 + k] = this.px[(y * this.w + x) * 4 + k];
    const chunk = (t: string, d: Buffer) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }
}

const BIOME: Record<string, string> = { sea: '#122a44', river: '#346a8a', meadow: '#5a7a44', forest: '#2c5434', marsh: '#4e6452', desert: '#c4a46a', tundra: '#98aaa6', mountain: '#7a7068', peak: '#e2e8ee', beach: '#d6c698' };
const MAT: Record<string, string> = { stone: '#96989e', wood: '#3a6a2c', clay: '#b86846', sand: '#e2ce88', fiber: '#a8c468', food: '#c84870', ore: '#845cb0', crystal: '#78ecf4', marble: '#eeebe4', ochre: '#b5532f', indigo: '#2f408c', shell: '#f2ded6', amber: '#eaa53c' };

// The picture of what `a` can see right now, centred on it. T pixels per tile.
export function picture(w: World, a: Agent, T = 24): Buffer {
  const r = w.sight(a), n = 2 * r + 1, g = new Raster(n * T, n * T), ox = a.x - r, oy = a.y - r;
  const inSight = (x: number, y: number) => w.dist(a.x, a.y, x, y) <= r;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = ox + i, y = oy + j, sx = i * T, sy = j * T;
    if (!inSight(x, y) || !w.geo.inside(x, y)) { g.fillStyle = '#0b0e0c'; g.fillRect(sx, sy, T, T); continue; }
    g.fillStyle = BIOME[w.geo.biomeAt(x, y)] ?? '#444'; g.fillRect(sx, sy, T, T);
    const d = w.depositAt(x, y); if (d.m && d.amt > 0 && w.geo.rich[y * w.geo.w + x]) { g.fillStyle = MAT[d.m] ?? '#fff'; g.fillRect(sx + T * 0.38, sy + T * 0.38, T * 0.24, T * 0.24); }
    const b = w.blocks.get(`${x},${y}`);
    if (b) {
      g.fillStyle = b.color;
      if ((b as any).m === 'fence') { g.fillRect(sx, sy + T * 0.35, T, T * 0.12); g.fillRect(sx, sy + T * 0.65, T, T * 0.12); }
      else if ((b as any).m === 'fire') { g.fillStyle = '#8d8a82'; g.beginPath(); g.ellipse(sx + T / 2, sy + T / 2, T * 0.38, T * 0.38); g.fill(); g.fillStyle = w.fireLit(b) ? '#f08a30' : '#3a3632'; g.beginPath(); g.ellipse(sx + T / 2, sy + T / 2, T * 0.24, T * 0.24); g.fill(); }
      else { g.fillRect(sx, sy, T, T); if (b.kind === 'wall') { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(sx, sy + T - 3, T, 3); g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(sx, sy, T, 2); } }
    }
    if (w.itemsAt({ t: [x, y] }).length) { g.fillStyle = '#efe4c8'; g.fillRect(sx + T * 0.62, sy + T * 0.62, T * 0.28, T * 0.22); }
  }
  // roofs over everything on the ground, a little see-through so what is under a roof still shows
  for (const [k, b] of w.roofs) { const [x, y] = k.split(',').map(Number); if (!inSight(x, y)) continue; g.fillStyle = hexA(b.color, 0.8); g.fillRect((x - ox) * T, (y - oy) * T, T, T); }
  for (const an of w.fauna.list) {
    if (!w.fauna.alive(an, w.now())) continue; const [x, y] = w.animalPos(an); if (!inSight(x, y)) continue;
    Critters.beast(g, an.sp, (x - ox + 0.5) * T, (y - oy + 0.5) * T, T * 0.9, 1, an.tamedBy ? w.agents.get(an.tamedBy)?.name ?? an.tamedBy : null);
  }
  const bodies = [...w.agents.values()].filter(o => (o.state === 'active' || o.state === 'resting') && inSight(o.x, o.y)).sort((p, q) => p.y - q.y);
  for (const o of bodies) Critters.draw(g, { name: o.name, look: (o.meta as any)?.look, worn: w.has(o, 'cloak') ? ['cloak'] : [], state: o.state }, (o.x - ox + 0.5) * T, (o.y - oy + 0.5) * T, T);
  g.fillStyle = '#f0c46a'; g.beginPath(); g.moveTo((r + 0.5) * T - 4, r * T - T * 0.4); g.lineTo((r + 0.5) * T + 4, r * T - T * 0.4); g.lineTo((r + 0.5) * T, r * T - T * 0.4 + 5); g.fill(); // you
  if (w.night()) { g.fillStyle = 'rgba(8,12,32,.35)'; g.fillRect(0, 0, g.w, g.h); }
  return g.png();
}
const hexA = (c: string, a: number) => /^#[0-9a-f]{6}$/i.test(c) ? `rgba(${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${a})` : c;
