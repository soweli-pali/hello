// Animals. Their wandering is a pure function of (seed, time), so it costs no events and replays exactly.
// Only things that change them (hurt, killed, tamed) are events.
import { hash, BIOMES } from './geo.ts';
import type { Geo, Biome, Material } from './geo.ts';

export interface Species {
  biomes: Biome[]; hp: number; range: number; count: number;
  drop: Partial<Record<Material, number>>; tame?: boolean; bites?: number; words: string; map: string;
}
export const SPECIES: Record<string, Species> = {
  deer: { biomes: ['meadow', 'forest'], hp: 3, range: 10, count: 70, drop: { food: 4, fiber: 1 }, words: 'a deer', map: 'd' },
  goat: { biomes: ['mountain', 'tundra', 'peak'], hp: 3, range: 7, count: 45, drop: { food: 3, fiber: 2 }, tame: true, words: 'a mountain goat', map: 'g' },
  wolf: { biomes: ['forest', 'tundra'], hp: 6, range: 16, count: 26, drop: { fiber: 3, food: 1 }, bites: 2, words: 'a wolf', map: 'w' },
};
const STEP_MS = 6000;

export interface Animal { id: string; sp: string; hx: number; hy: number; hp: number; deadUntil: number; tamedBy: string | null; }

export class Fauna {
  list: Animal[] = []; byId = new Map<string, Animal>(); geo: Geo; seed: number;
  constructor(geo: Geo, seed: number) {
    this.geo = geo; this.seed = seed;
    let n = 0;
    for (const [sp, s] of Object.entries(SPECIES)) {
      const ok = new Set(s.biomes.map(b => BIOMES.indexOf(b)));
      for (let k = 0, tries = 0; k < s.count && tries < 20000; tries++) {
        const x = Math.floor(hash(tries, n, seed * 13 + 5) * geo.w), y = Math.floor(hash(n, tries, seed * 17 + 9) * geo.h);
        if (!ok.has(geo.biome[y * geo.w + x])) continue;
        const a: Animal = { id: `${sp[0]}${k + 1}`, sp, hx: x, hy: y, hp: s.hp, deadUntil: 0, tamedBy: null };
        this.list.push(a); this.byId.set(a.id, a); k++; n++;
      }
    }
  }
  alive(a: Animal, t: number) { return a.deadUntil <= t; }
  // Smooth wander around home; animals stay in their biomes and out of walls.
  pos(a: Animal, t: number, owner?: { x: number; y: number }, blocked?: (x: number, y: number) => boolean): [number, number] {
    if (a.tamedBy && owner) return [owner.x, owner.y];
    const s = SPECIES[a.sp], ok = new Set(s.biomes.map(b => BIOMES.indexOf(b)));
    const f = t / STEP_MS / 8, i = Math.floor(f), fr = f - i, sm = fr * fr * (3 - 2 * fr), sd = this.seed * 7 + a.hx * 31 + a.hy;
    const wob = (k: number) => { const a0 = hash(i, k, sd), a1 = hash(i + 1, k, sd); return (a0 + (a1 - a0) * sm) * 2 - 1; };
    for (let shrink = 1; shrink >= 0; shrink -= 0.25) {
      const x = Math.round(a.hx + wob(1) * s.range * shrink), y = Math.round(a.hy + wob(2) * s.range * shrink);
      if (this.geo.inside(x, y) && ok.has(this.geo.biome[y * this.geo.w + x]) && !blocked?.(x, y)) return [x, y];
    }
    return [a.hx, a.hy];
  }
}
