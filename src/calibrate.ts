// How long and how dangerous are journeys? Shortest-AP routes on the real map, measured in real time and vigor.
//   node src/calibrate.ts [--seed 7] [--from x,y] [--gear boat,cloak,waterskin]
import { Geo, BIOMES, BIOME_INFO } from './geo.ts';
import type { Biome } from './geo.ts';
import { DEFAULTS } from './world.ts';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const cfg = { ...DEFAULTS, seed: Number(opt('seed') ?? DEFAULTS.seed) };
const geo = new Geo(cfg.w, cfg.h, cfg.seed), W = cfg.w, H = cfg.h;
const from = (opt('from')?.split(',').map(Number) ?? geo.landing()) as [number, number];
const gear = new Set((opt('gear') ?? '').split(',').filter(Boolean));
const water = (b: Biome) => b === 'sea' || b === 'river';
const cost = (b: Biome) => water(b) && gear.has('boat') ? 1 : BIOME_INFO[b].cost;
const drain = (b: Biome) => { const i = BIOME_INFO[b]; return water(b) && gear.has('boat') ? 0 : i.guard && gear.has(i.guard) ? 0 : i.drain; };

// Dijkstra on AP (8-neighbour, like the world's own steps)
const dist = new Float64Array(W * H).fill(Infinity), prev = new Int32Array(W * H).fill(-1);
const heap: [number, number][] = []; const push = (d: number, i: number) => { heap.push([d, i]); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
const start = from[1] * W + from[0]; dist[start] = 0; push(0, start);
while (heap.length) {
  const [d, i] = pop(); if (d > dist[i]) continue;
  const x = i % W, y = (i / W) | 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue; const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx, nd = d + cost(BIOMES[geo.biome[j]]); if (nd < dist[j]) { dist[j] = nd; prev[j] = i; push(nd, j); }
  }
}
// walk a route back and account for vigor: drained per step, regenerating with elapsed time
function trip(j: number) {
  const path: number[] = []; for (let k = j; k !== -1; k = prev[k]) path.push(k); path.reverse();
  let vig = cfg.vigorMax, low = vig, drained = 0;
  for (let s = 1; s < path.length; s++) {
    const b = BIOMES[geo.biome[path[s]]], dt = cost(b) * cfg.apSec;
    vig = Math.min(cfg.vigorMax, vig + dt / cfg.vigorSec) - drain(b); drained += drain(b); low = Math.min(low, vig);
  }
  const counts: Record<string, number> = {}; for (const k of path.slice(1)) { const b = BIOMES[geo.biome[k]]; counts[b] = (counts[b] ?? 0) + 1; }
  return { steps: path.length - 1, ap: dist[j], low, drained, counts };
}
const mins = (ap: number) => ap * cfg.apSec / 60;
const fmt = (m: number) => m < 60 ? `${m.toFixed(0)} min` : `${(m / 60).toFixed(1)} h`;
const verdict = (low: number) => low > 3 ? 'fine' : low > 0 ? 'risky' : `deadly without ${Math.ceil(-low / 3 + 0.01)} food or gear`;
const rows: string[][] = [];
function row(label: string, j: number) {
  if (!Number.isFinite(dist[j])) return rows.push([label, 'unreachable', '', '', '', '']);
  const t = trip(j), x = j % W, y = (j / W) | 0;
  const via = Object.entries(t.counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([b, n]) => `${b} ${n}`).join(', ');
  rows.push([label, `(${x},${y})`, `${t.steps}`, `${t.ap.toFixed(0)} AP`, fmt(mins(t.ap)), `${verdict(t.low)} · via ${via}`]);
}
for (const b of BIOMES) {
  let best = -1; for (let j = 0; j < W * H; j++) if (BIOMES[geo.biome[j]] === b && (best < 0 || dist[j] < dist[best])) best = j;
  if (best >= 0) row(`nearest ${b}`, best);
}
for (const m of ['ore', 'crystal']) {
  let best = -1; for (let j = 0; j < W * H; j++) if (geo.mat[j] && ['stone', 'wood', 'clay', 'sand', 'fiber', 'food', 'ore', 'crystal'][geo.mat[j] - 1] === m && (best < 0 || dist[j] < dist[best])) best = j;
  if (best >= 0) row(`nearest ${m}`, best);
}
let far = -1; for (let j = 0; j < W * H; j++) if (!water(BIOMES[geo.biome[j]]) && Number.isFinite(dist[j]) && (far < 0 || dist[j] > dist[far])) far = j;
row('farthest land', far);

console.log(`seed ${cfg.seed}, from (${from[0]},${from[1]}) in ${geo.biomeAt(from[0], from[1])}, gear: ${[...gear].join(', ') || 'none'}`);
console.log(`pace: ${cfg.apMax} AP stored, +1 AP / ${cfg.apSec}s → sustained ${(60 / cfg.apSec).toFixed(0)} AP/min. Meadow ${(60 / cfg.apSec).toFixed(0)} tiles/min, forest ${(30 / cfg.apSec).toFixed(0)}, mountain ${(15 / cfg.apSec).toFixed(1)}, peak ${(7.5 / cfg.apSec).toFixed(1)}; roads ${(120 / cfg.apSec).toFixed(0)}.`);
console.log(`vigor: ${cfg.vigorMax} max, +1 / ${cfg.vigorSec}s; food +3.`);
const widths = rows[0].map((_, c) => Math.max(...rows.map(r => r[c].length)));
for (const r of rows) console.log(r.map((v, c) => v.padEnd(widths[c])).join('  '));
