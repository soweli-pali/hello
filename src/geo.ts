// Geography: deterministic from the seed, computed once, never stored.
// Large biomes from elevation / temperature / moisture; rivers cut through; the sea rings the land.

export const BIOMES = ['sea', 'river', 'meadow', 'forest', 'marsh', 'desert', 'tundra', 'mountain', 'peak'] as const;
export type Biome = typeof BIOMES[number];
export const MATERIALS = ['stone', 'wood', 'clay', 'sand', 'fiber', 'food', 'ore', 'crystal'] as const;
export type Material = typeof MATERIALS[number];

export const BIOME_INFO: Record<Biome, { cost: number; drain: number; guard?: string; map: string; words: string }> = {
  sea:      { cost: 8, drain: 0.5, guard: 'boat',      map: '~', words: 'open water' },
  river:    { cost: 5, drain: 0.5, guard: 'boat',      map: '~', words: 'a river' },
  meadow:   { cost: 1, drain: 0,                       map: '.', words: 'meadow' },
  forest:   { cost: 2, drain: 0,                       map: '"', words: 'forest' },
  marsh:    { cost: 3, drain: 0.05,                    map: ',', words: 'marsh' },
  desert:   { cost: 2, drain: 0.3, guard: 'waterskin', map: ':', words: 'desert' },
  tundra:   { cost: 2, drain: 0.3, guard: 'cloak',     map: "'", words: 'frozen tundra' },
  mountain: { cost: 4, drain: 0.1,                     map: '^', words: 'mountainside' },
  peak:     { cost: 8, drain: 0.6, guard: 'cloak',     map: 'A', words: 'a high, icy peak' },
};
// Which materials pool in which biomes (relative weights). Ore and crystal are placed separately: rare and clustered.
const YIELD: Partial<Record<Biome, Partial<Record<Material, number>>>> = {
  meadow: { fiber: 3, food: 2, clay: 1, stone: 0.5 },
  forest: { wood: 5, food: 2, fiber: 1 },
  marsh: { clay: 4, fiber: 3, food: 1 },
  desert: { sand: 6, stone: 1 },
  tundra: { stone: 3, food: 0.6 },
  mountain: { stone: 6 },
  peak: { stone: 2 },
};
const DENSITY: Partial<Record<Biome, number>> = { meadow: 0.66, forest: 0.6, marsh: 0.62, desert: 0.7, tundra: 0.72, mountain: 0.64, peak: 0.75 };
export const REGROW: Record<Material, number> = { stone: 1, wood: 1, clay: 1, sand: 1, fiber: 0.7, food: 0.4, ore: 5, crystal: 12 }; // × regenSec

export function hash(x: number, y: number, s: number) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function noise(x: number, y: number, scale: number, s: number) {
  const gx = x / scale, gy = y / scale, x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, s), b = hash(x0 + 1, y0, s), c = hash(x0, y0 + 1, s), d = hash(x0 + 1, y0 + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const fbm = (x: number, y: number, scale: number, s: number) =>
  noise(x, y, scale, s) * 0.55 + noise(x, y, scale / 2.3, s + 1) * 0.28 + noise(x, y, scale / 5.1, s + 2) * 0.17;

export class Geo {
  w: number; h: number; seed: number;
  biome: Uint8Array; mat: Uint8Array; cap: Uint8Array; elev: Uint8Array;
  constructor(w: number, h: number, seed: number) {
    this.w = w; this.h = h; this.seed = seed;
    const n = w * h; this.biome = new Uint8Array(n); this.mat = new Uint8Array(n); this.cap = new Uint8Array(n); this.elev = new Uint8Array(n);
    const S = seed * 97;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // domain warp: bend the coordinates so shapes twist and fray instead of pooling into blobs
      const wx = x + (fbm(x, y, w * 0.09, S + 1) - 0.5) * w * 0.16, wy = y + (fbm(x, y, w * 0.09, S + 2) - 0.5) * w * 0.16;
      const ex = Math.min(x, w - 1 - x) / (w * 0.12), ey = Math.min(y, h - 1 - y) / (h * 0.12);
      const edge = Math.min(1, Math.min(ex, ey));
      // elevation: warped fbm, plus ridged noise (sharp crests) where the land is already high, plus fine grit
      let e = (fbm(wx, wy, w * 0.2, S + 10) - 0.5) * 1.9 + 0.56;
      const ridge = 1 - Math.abs(noise(wx, wy, w * 0.07, S + 11) * 2 - 1), ridge2 = 1 - Math.abs(noise(wx, wy, w * 0.025, S + 12) * 2 - 1);
      e += Math.max(0, e - 0.5) * (ridge ** 3 * 1.1 + ridge2 ** 2 * 0.3) - 0.06;
      e += (noise(x, y, 3.1, S + 13) - 0.5) * 0.05;
      e = e * (0.5 + 0.5 * edge) + (edge - 1) * 0.3;
      let t = (fbm(wx, wy, w * 0.3, S + 20) - 0.5) * 1.4 + 0.5 + (y / h - 0.5) * 0.5 - Math.max(0, e - 0.6) * 0.6; // south and heights are colder
      let m = (fbm(wx, wy, w * 0.22, S + 30) - 0.5) * 1.6 + 0.5;
      const fray = (noise(x, y, 5, S + 31) - 0.5) * 0.07; t += fray; m -= fray; // ragged biome borders
      this.elev[i] = Math.max(0, Math.min(255, Math.round(e * 200)));
      const dc = 99; // no enforced heartland: operators choose where agents arrive
      let b: Biome;
      if (e < 0.3) b = 'sea';
      else if (e > 0.8 && ridge > 0.62) b = 'peak';
      else if (e > 0.69) b = 'mountain';
      else if (t < 0.3) b = 'tundra';
      else if (t > 0.66 && m < 0.46) b = 'desert';
      else if (m > 0.62) b = 'marsh';
      else if (m > 0.47) b = 'forest';
      else b = 'meadow';
      // rivers: thin ridges of a separate noise field, only through lowland
      const r = Math.abs(noise(wx, wy, w * 0.12, S + 40) - 0.5) + Math.abs(noise(x, y, w * 0.05, S + 41) - 0.5) * 0.25;
      if (r < 0.022 && e < 0.66 && b !== 'sea' && dc > 0.35) b = 'river';
      this.biome[i] = BIOMES.indexOf(b);
      // deposits
      const y0 = YIELD[b];
      if (y0) {
        let best: Material | null = null, bv = 0, k = 0;
        for (const [mm, wt] of Object.entries(y0) as [Material, number][]) {
          const v = noise(x, y, 7 + k * 2, S + 50 + k) * Math.pow(wt, 0.18); k++;
          if (v > bv) { bv = v; best = mm; }
        }
        const rich = noise(x, y, 11, S + 60);
        const th = DENSITY[b]!;
        if (best && bv > th && rich > 0.35) { this.mat[i] = MATERIALS.indexOf(best) + 1; this.cap[i] = Math.max(1, Math.min(9, 1 + Math.floor((bv - th) * 30 * rich))); }
      }
      // ore: small veins in the mountains. crystal: rare glints on peaks and deep desert.
      if (b === 'mountain' && noise(x, y, 4, S + 70) > 0.84 && noise(x, y, 40, S + 71) > 0.45) { this.mat[i] = MATERIALS.indexOf('ore') + 1; this.cap[i] = 2 + Math.floor(hash(x, y, S + 72) * 4); }
      if ((b === 'peak' || (b === 'desert' && t > 0.8)) && hash(x, y, S + 80) < 0.006) { this.mat[i] = MATERIALS.indexOf('crystal') + 1; this.cap[i] = 1 + Math.floor(hash(x, y, S + 81) * 2); }
    }
  }
  inside(x: number, y: number) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  biomeAt(x: number, y: number): Biome { return this.inside(x, y) ? BIOMES[this.biome[y * this.w + x]] : 'sea'; }
  depositAt(x: number, y: number): { m: Material | null; cap: number } {
    if (!this.inside(x, y)) return { m: null, cap: 0 };
    const i = y * this.w + x; return this.mat[i] ? { m: MATERIALS[this.mat[i] - 1], cap: this.cap[i] } : { m: null, cap: 0 };
  }
  // A good default arrival point: the meadow or forest tile nearest the middle that is well inland.
  landing(): [number, number] {
    const cx = this.w >> 1, cy = this.h >> 1;
    for (let r = 0; r < this.w; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = cx + dx, y = cy + dy, b = this.biomeAt(x, y); if (b !== 'meadow' && b !== 'forest') continue;
      let ok = true; // well inland: nothing but land for 8 tiles around
      for (let j = -8; j <= 8 && ok; j++) for (let i = -8; i <= 8 && ok; i++) { const n = this.biomeAt(x + i, y + j); if (n === 'sea' || n === 'river' || n === 'peak') ok = false; }
      if (ok) return [x, y];
    }
    return [cx, cy];
  }
  // one byte per tile for the viewer: biome in the high nibble, deposit material in the low
  bytes() { const b = new Uint8Array(this.w * this.h); for (let i = 0; i < b.length; i++) b[i] = (this.biome[i] << 4) | this.mat[i]; return b; }
}
