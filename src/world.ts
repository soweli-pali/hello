// The world: physics, not society. All state changes go through emit() -> apply(),
// and apply() is the only thing replay uses, so the event log is the source of truth.
import { CHANGES } from './changes.ts';
import '../viewer/critters.js';
import { picture } from './picture.ts';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { runHandler } from './sandbox.ts';
import { Geo, MATERIALS, BIOME_INFO, REGROW, hash } from './geo.ts';
import type { Material, Biome } from './geo.ts';
import { Fauna, SPECIES } from './fauna.ts';
import type { Animal } from './fauna.ts';

export { MATERIALS };
export type { Material };
// What can be built. Each block has a fixed look; plaster, cloth and gardens take dyes. The finest need far-off materials.
// Three layers per tile: the ground, one block (a wall, or a floor-level thing), and optionally a roof above.
export interface BlockType {
  needs: Partial<Record<Material, number>>; s: number; color: string; words: string;
  floor?: boolean;   // walkable, fast (0.5 AP) like a road
  roof?: boolean;    // goes on the roof layer, over a floor or bare ground; must be within 3 tiles of a wall
  dye?: boolean; glow?: boolean; bridge?: boolean;
  door?: boolean;    // a wall people walk through; animals can't
  fence?: boolean;   // a low wall: animals can't cross, people step over (2 AP); doesn't close a room
  fire?: boolean;    // burns for a while: light, warmth, and wolves keep away
  heavy?: boolean;   // too heavy to set alone: someone else must be within reach to help
}
export const BLOCKS: Record<string, BlockType> = {
  stone:     { needs: { stone: 1 }, s: 4, color: '#8e8a82', words: 'rough stone wall' },
  cobble:    { needs: { stone: 1 }, s: 2, floor: true, color: '#77736b', words: 'cobbled road' },
  plank:     { needs: { wood: 1 }, s: 3, color: '#9b6c40', words: 'plank wall' },
  floor:     { needs: { wood: 1 }, s: 1, floor: true, bridge: true, color: '#b3875a', words: 'wooden floor (bridges water)' },
  log:       { needs: { wood: 2 }, s: 6, color: '#6a4a2c', words: 'log wall' },
  door:      { needs: { wood: 2 }, s: 3, door: true, color: '#7b5330', words: 'wooden door (people pass, animals don\'t)' },
  fence:     { needs: { wood: 1 }, s: 2, fence: true, color: '#8a6a44', words: 'wooden fence (animals can\'t cross)' },
  fire:      { needs: { wood: 2 }, s: 1, floor: true, fire: true, glow: true, color: '#e0702a', words: 'campfire (burns about 4 hours; add wood to keep it going)' },
  brick:     { needs: { clay: 1 }, s: 3, color: '#a9573b', words: 'brick wall' },
  tile:      { needs: { clay: 1 }, s: 1, floor: true, color: '#bb6d4a', words: 'terracotta tile floor' },
  plaster:   { needs: { clay: 1, sand: 1 }, s: 2, dye: true, color: '#e4ddcf', words: 'plastered wall' },
  sandstone: { needs: { sand: 2 }, s: 3, color: '#d7c08a', words: 'sandstone wall' },
  glass:     { needs: { sand: 3, wood: 1 }, s: 1, color: '#bfe3ea', words: 'glass' },
  cloth:     { needs: { fiber: 1 }, s: 1, floor: true, dye: true, color: '#e9e2d3', words: 'woven cloth' },
  garden:    { needs: { food: 1, fiber: 1 }, s: 1, floor: true, dye: true, color: '#5f8f4a', words: 'flower garden' },
  marble:    { needs: { marble: 1 }, s: 6, heavy: true, color: '#eeebe4', words: 'marble (heavy: needs a helper)' },
  mosaic:    { needs: { shell: 1, clay: 1 }, s: 1, floor: true, dye: true, color: '#efe3d6', words: 'shell mosaic floor' },
  iron:      { needs: { ore: 1 }, s: 10, heavy: true, color: '#4c4f58', words: 'iron wall (heavy: needs a helper)' },
  crystal:   { needs: { crystal: 1 }, s: 4, glow: true, color: '#8fe9f1', words: 'glowing crystal' },
  lamp:      { needs: { amber: 1, ore: 1 }, s: 2, glow: true, color: '#eaa53c', words: 'amber lamp' },
  // roofs
  thatch:    { needs: { fiber: 2 }, s: 1, roof: true, color: '#c9ab5a', words: 'thatched roof' },
  shingle:   { needs: { wood: 1 }, s: 2, roof: true, color: '#6e5238', words: 'wooden shingle roof' },
  rooftile:  { needs: { clay: 1 }, s: 2, roof: true, dye: true, color: '#b25a3c', words: 'clay tile roof' },
  slate:     { needs: { stone: 1 }, s: 3, roof: true, color: '#5b6068', words: 'slate roof' },
  skylight:  { needs: { sand: 2, wood: 1 }, s: 1, roof: true, color: '#cfe8ee', words: 'glass skylight roof' },
};
export const FIRE_MS = 4 * 3600_000;
export const COMMON = new Set(['stone', 'wood', 'clay', 'sand', 'fiber', 'food']); // what every body knows the uses of
export const WINDED_MS = 60_000; // after striking a person, a body can't strike anyone for a minute
export const DYES: Record<string, string> = { ochre: '#b5532f', indigo: '#2f408c', shell: '#f2eadd' };
function hexMix(cols: string[]) {
  const v = cols.map(c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)));
  return '#' + [0, 1, 2].map(k => Math.round(v.reduce((a, c) => a + c[k], 0) / v.length).toString(16).padStart(2, '0')).join('');
}
// Dyed blocks take the dyes' mixed colour, lightly carrying the block's own; mixing two or three dyes widens the palette.
export function blockColor(type: string, dyes: string[] = []) {
  const bt = BLOCKS[type]; if (!bt) return '#888888';
  if (!dyes.length || !bt.dye) return bt.color;
  const d = hexMix(dyes.map(x => DYES[x])); return hexMix([d, d, d, bt.color]);
}
const MAT_BLOCK: Record<string, string> = { stone: 'stone', wood: 'plank', clay: 'brick', sand: 'sandstone', ore: 'iron', crystal: 'crystal', marble: 'marble' };
export const KINDS = ['text', 'svg', 'html', 'abc', 'object', 'tool'] as const;
export type Kind = typeof KINDS[number];
const MAX_BODY: Record<Kind, number> = { text: 20_000, svg: 60_000, html: 100_000, abc: 20_000, object: 20_000, tool: 500 };

// Tools are the world's technology: they change what a body can do while carried. They cannot be copied.
export const RECIPES: Record<string, { needs: Partial<Record<Material, number>>; does: string }> = {
  pick: { needs: { wood: 2, stone: 3 }, does: 'lets you gather ore and crystal, and gather up to 5 units at once' },
  spear: { needs: { wood: 2, stone: 1 }, does: 'your blows do 3 damage instead of 1' },
  waterskin: { needs: { clay: 3, fiber: 2 }, does: 'deserts no longer drain your vigor' },
  cloak: { needs: { fiber: 8 }, does: 'cold (tundra, peaks) no longer drains your vigor' },
  boat: { needs: { wood: 10, fiber: 4 }, does: 'water costs 1 AP per tile and no vigor; you can fish (gather on water)' },
  cart: { needs: { wood: 8, ore: 2 }, does: 'carry 60 more units' },
  lantern: { needs: { ore: 1, crystal: 1, sand: 2 }, does: 'see normally at night; wolves keep their distance' },
  compass: { needs: { ore: 3, crystal: 1 }, does: 'you know exact coordinates, and can move or aim by x,y' },
  spyglass: { needs: { ore: 2, crystal: 2, sand: 3 }, does: 'see twice as far' },
};

export interface Config {
  w: number; h: number; seed: number;
  apMax: number; apSec: number;       // action points: max, seconds per point
  regenSec: number;                   // seconds per material unit regenerated on a tile (× per-material factor)
  see: number; hear: number; reach: number;
  vigorMax: number; vigorSec: number; // vigor regenerates 1 per vigorSec
  carry: number;                      // material units a bare body can carry
  respawnSec: number; permadeath: boolean;
  safeRadius: number;                 // nobody can be harmed this close to the default landing point (0 = nowhere is safe)
  harm: boolean;                      // whether agents can strike each other at all
  discovery: boolean;                 // newcomers must discover recipes and fine blocks (bodies that joined before it was on know everything)
  dayMin: number;                     // real minutes per day/night cycle (1440: a real day)
  dayOffset: number;                  // where in the cycle the clock's zero falls; 5/6 with a 24h day puts dawn at 04:00 UTC
  animalRespawnMin: number;
  ruins: number;
}
// Tuned for a world that runs for days or weeks: big, slow, with journeys that take hours.
export const DEFAULTS: Config = {
  w: 1024, h: 1024, seed: 7, apMax: 30, apSec: 6, regenSec: 900, see: 6, hear: 10, reach: 2,
  vigorMax: 10, vigorSec: 240, carry: 40, respawnSec: 1800, permadeath: true, safeRadius: 0, harm: true, discovery: true,
  dayMin: 1440, dayOffset: 5 / 6, animalRespawnMin: 120, ruins: 14,
};

export type Loc = { a: string } | { o: string } | { t: [number, number] };
export interface Agent {
  id: string; name: string; x: number; y: number;
  ap: number; apT: number; vig: number; vigT: number; mats: Record<string, number>;
  notebook: string; blocked: Set<string>; state: 'active' | 'resting' | 'left' | 'dead';
  deadUntil: number; lastBite: number; lastSwing?: number; noticed?: number; discovers?: boolean; knows?: Set<string>; deaths: number; home: [number, number];
  joined: number; lastSeen: number; meta: Record<string, unknown>;
  hearCursor: number; // in-memory only: last event seq this agent has been shown
}
export interface Block { m: string; color: string; s: number; by: string; t: number; kind: 'wall' | 'road' | 'roof'; dye?: string[] }
export interface Item {
  id: string; kind: Kind; title: string; body: string; author: string; t: number;
  hash: string; cites: string[]; loc: Loc; state?: unknown; mats?: Record<string, number>;
}
export interface Ev { seq: number; t: number; type: string; a?: string; [k: string]: any }
export interface Result { ok: boolean; text: string; data?: unknown }

const DIRS: Record<string, [number, number]> = {
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1],
};
const LETTER: Record<Material, string> = { stone: 'S', wood: 'W', clay: 'C', sand: 'N', fiber: 'F', food: 'B', ore: 'O', crystal: 'X', marble: 'M', ochre: 'R', indigo: 'I', shell: 'H', amber: 'Y' };
export const key = (x: number, y: number) => `${x},${y}`;
const ALIAS: Record<string, string> = { berries: 'food', berry: 'food', fish: 'food', meat: 'food', logs: 'wood', log: 'wood', timber: 'wood', rock: 'stone', rocks: 'stone', pebbles: 'stone', mud: 'clay', grass: 'fiber', reeds: 'fiber', iron: 'ore', gems: 'crystal', gem: 'crystal', dye: 'ochre', shells: 'shell' };
const locKey = (l: Loc) => 'a' in l ? `a:${l.a}` : 'o' in l ? `o:${l.o}` : `t:${l.t[0]},${l.t[1]}`;
const clampStr = (s: unknown, n: number) => String(s ?? '').slice(0, n);
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + (b > 0 ? b : 0), 0);
const isWater = (b: Biome) => b === 'sea' || b === 'river';

const LORE = [
  'We came from the middle and walked until the grass ran out. The cold keeps what it is given.',
  'Stone remembers who stacked it. Nobody else does.',
  'The river does not care about your cart.',
  'Three of us went up the white mountain. One map came down.',
  'Light is heavy to carry and light to hold. Glass, ore, a piece of the sky.',
  'Here the wolves were our neighbours. We built the wall anyway.',
  'If you are reading this, you walked further than most. Leave something.',
  'We traded everything for the crossing, and the far shore was only more shore.',
];
const RUIN_TOOLS = ['compass', 'lantern', 'spyglass', 'boat', 'cloak', 'pick', 'waterskin', 'cart'];

export class World {
  cfg: Config; db: DatabaseSync; seq = 0; geo: Geo; fauna: Fauna;
  agents = new Map<string, Agent>();
  byName = new Map<string, string>();
  blocks = new Map<string, Block>();
  roofs = new Map<string, Block>();
  taken = new Map<string, { amt: number; t: number }>();
  ground = new Map<string, Record<string, number>>(); // loose materials lying on tiles
  items = new Map<string, Item>();
  held = new Map<string, Set<string>>(); // locKey -> item ids
  recent: Ev[] = [];
  listeners = new Set<(e: Ev) => void>();
  now = () => Date.now();

  constructor(file: string, cfg: Partial<Config> = {}, now?: () => number) {
    if (now) this.now = now; // a simulation brings its own clock, and the world's making should happen on it too
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, t INTEGER, type TEXT, a TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, agent TEXT);`);
    const saved = this.db.prepare('SELECT v FROM meta WHERE k=?').get('config') as any;
    this.cfg = { ...DEFAULTS, ...(saved ? JSON.parse(saved.v) : {}), ...cfg };
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('config', JSON.stringify(this.cfg));
    this.geo = new Geo(this.cfg.w, this.cfg.h, this.cfg.seed);
    this.fauna = new Fauna(this.geo, this.cfg.seed);
    for (const r of this.db.prepare('SELECT * FROM events ORDER BY seq').iterate() as any) {
      const e: Ev = { ...JSON.parse(r.data), seq: r.seq, t: r.t, type: r.type, a: r.a ?? undefined };
      this.apply(e);
      this.remember(e);
    }
    for (const a of this.agents.values()) a.hearCursor = this.seq;
    if (this.seq === 0) this.genesis();
  }

  // ---------- event core ----------
  emit(type: string, a: string | undefined, data: Record<string, unknown> = {}): Ev {
    const e: Ev = { ...data, seq: this.seq + 1, t: this.now(), type, a };
    this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(e.seq, e.t, type, a ?? null, JSON.stringify(data));
    this.apply(e);
    this.remember(e);
    for (const f of this.listeners) try { f(e); } catch { /* viewer hiccups never break the world */ }
    return e;
  }
  private remember(e: Ev) { this.recent.push(e); if (this.recent.length > 4000) this.recent.splice(0, 1000); }

  apply(e: Ev) {
    this.seq = e.seq;
    const ag = e.a ? this.agents.get(e.a) : undefined;
    if (ag) {
      ag.lastSeen = e.t;
      if (e.cost) { ag.ap = this.apOf(ag, e.t) - e.cost; ag.apT = e.t; }
      if (e.dv) { ag.vig = Math.min(this.cfg.vigorMax, this.vigOf(ag, e.t) + e.dv); ag.vigT = e.t; }
      if (ag.state === 'resting' && e.type !== 'rest' && e.type !== 'hurt') ag.state = 'active';
    }
    switch (e.type) {
      case 'join': {
        const a: Agent = { id: e.a!, name: e.name, x: e.x, y: e.y, ap: this.cfg.apMax, apT: e.t, vig: this.cfg.vigorMax, vigT: e.t, mats: {},
          notebook: '', blocked: new Set(), state: 'active', deadUntil: 0, lastBite: 0, deaths: 0, home: [e.x, e.y], joined: e.t, lastSeen: e.t, meta: e.meta ?? {}, hearCursor: e.seq, discovers: !!e.discover, knows: new Set() };
        this.agents.set(a.id, a); this.byName.set(a.name.toLowerCase(), a.id); break;
      }
      case 'move': ag!.x = e.x; ag!.y = e.y; break;
      case 'home': this.dropAll(ag!, e.from[0], e.from[1]); ag!.x = e.x; ag!.y = e.y; break;
      case 'gather': {
        if (e.loose) { const g = this.ground.get(key(e.x, e.y))!; g[e.m] -= e.n; }
        else if (e.m !== 'food' || !e.fish) this.taken.set(key(e.x, e.y), { amt: this.depositAt(e.x, e.y, e.t).amt - e.n, t: e.t });
        ag!.mats[e.m] = (ag!.mats[e.m] ?? 0) + e.n; break;
      }
      case 'place': case 'build': {
        if (ag) for (const [m, n] of Object.entries((e.needs ?? {}) as Record<string, number>)) ag.mats[m] -= n;
        const k = key(e.x, e.y), bt = BLOCKS[e.m] ?? BLOCKS.stone, layer = bt.roof ? this.roofs : this.blocks, b = layer.get(k);
        if (b) { b.s += bt.s; if (bt.fire) b.t = e.t; } // same block again reinforces; wood on a fire keeps it burning
        else layer.set(k, { m: e.m, color: e.color ?? blockColor(e.m, e.dye), s: bt.s, by: e.a ?? 'world', t: e.t, kind: bt.floor ? 'road' : bt.roof ? 'roof' : 'wall', dye: e.dye });
        break;
      }
      case 'remove': {
        const k = key(e.x, e.y), layer = e.roof ? this.roofs : this.blocks, b = layer.get(k)!;
        b.s -= e.dmg; if (b.s <= 0) layer.delete(k); break;
      }
      case 'make': case 'craft': {
        if (e.type === 'craft') for (const [m, n] of Object.entries(e.needs as Record<string, number>)) ag!.mats[m] -= n;
        const it: Item = { id: e.id, kind: e.kind ?? 'tool', title: e.title, body: e.body, author: e.author ?? e.a, t: e.t,
          hash: e.hash, cites: e.cites ?? [], loc: e.loc ?? { a: e.a } };
        if (it.kind === 'object') { it.state = null; it.mats = {}; }
        this.items.set(it.id, it); this.index(it, undefined); break;
      }
      case 'drop': { const g = this.groundAt(e.x, e.y); for (const [m, n] of Object.entries(e.mats as Record<string, number>)) g[m] = (g[m] ?? 0) + n; break; }
      case 'transfer': this.applyTransfer(e); break;
      case 'use': {
        const o = this.items.get(e.obj)!;
        if ('state' in e) o.state = e.state;
        for (const m of e.made ?? []) this.apply({ ...m, seq: e.seq, t: e.t, type: 'make', a: undefined });
        for (const tr of e.transfers ?? []) this.applyTransfer(tr);
        break;
      }
      case 'eat': ag!.mats.food -= e.n; break;
      case 'strike': {
        if (e.target) { const v = this.agents.get(e.target)!; v.vig = this.vigOf(v, e.t) - e.dmg; v.vigT = e.t; ag!.lastSwing = e.t; }
        if (e.animal) {
          const an = this.fauna.byId.get(e.animal)!;
          an.hp -= e.dmg;
          if (e.killed) {
            an.hp = SPECIES[an.sp].hp; an.deadUntil = e.t + this.cfg.animalRespawnMin * 60_000;
            if (an.tamedBy) { const [x, y] = [e.x, e.y]; an.tamedBy = null; an.hx = x; an.hy = y; }
            for (const [m, n] of Object.entries(e.gain ?? {})) ag!.mats[m] = (ag!.mats[m] ?? 0) + (n as number);
            const g = this.groundAt(e.x, e.y); for (const [m, n] of Object.entries(e.spill ?? {})) g[m] = (g[m] ?? 0) + (n as number);
          }
        }
        break;
      }
      case 'notice': ag!.noticed = e.v; break;
      case 'learn': ag!.knows!.add(e.what); break;
      case 'hurt': ag!.lastBite = e.cause === 'wolf' ? e.t : ag!.lastBite; break;
      case 'tame': { const an = this.fauna.byId.get(e.animal)!; an.tamedBy = e.a!; ag!.mats.food -= 1; break; }
      case 'die': {
        this.dropAll(ag!, ag!.x, ag!.y);
        ag!.state = 'dead'; ag!.deadUntil = e.until ?? Infinity; ag!.deaths++;
        break;
      }
      case 'wake': ag!.x = e.x; ag!.y = e.y; ag!.state = 'active'; ag!.vig = this.cfg.vigorMax; ag!.vigT = e.t; ag!.ap = this.cfg.apMax; ag!.apT = e.t; break;
      case 'note': ag!.notebook = e.text; break;
      case 'rest': ag!.state = 'resting'; break;
      case 'leave': this.releaseAnimals(ag!); ag!.state = 'left'; break;
      case 'block': e.on ? ag!.blocked.add(e.target) : ag!.blocked.delete(e.target); break;
      case 'config': Object.assign(this.cfg, e.cfg); break;
    }
  }

  // Death leaves a body's burden where it stood. (Old worlds may also hold 'home' events, from when going home was a free jump.)
  private dropAll(a: Agent, x: number, y: number) {
    const g = this.groundAt(x, y);
    for (const [m, n] of Object.entries(a.mats)) if (n > 0) g[m] = (g[m] ?? 0) + n;
    a.mats = {};
    for (const it of this.itemsAt({ a: a.id })) { const old = it.loc; it.loc = { t: [x, y] }; this.index(it, old); }
    this.releaseAnimals(a, x, y);
  }
  private releaseAnimals(a: Agent, x = a.x, y = a.y) {
    for (const an of this.fauna.list) if (an.tamedBy === a.id) { an.tamedBy = null; an.hx = x; an.hy = y; }
  }
  groundAt(x: number, y: number) { const k = key(x, y); let g = this.ground.get(k); if (!g) this.ground.set(k, g = {}); return g; }
  private applyTransfer(tr: any) {
    if (tr.item) { const it = this.items.get(tr.item)!; const old = it.loc; it.loc = tr.to; this.index(it, old); return; }
    const from = this.holder(tr.from), to = this.holder(tr.to);
    from[tr.m] -= tr.n; to[tr.m] = (to[tr.m] ?? 0) + tr.n;
  }
  private holder(l: Loc): Record<string, number> {
    if ('a' in l) return this.agents.get(l.a)!.mats;
    if ('o' in l) return this.items.get(l.o)!.mats!;
    return this.groundAt(l.t[0], l.t[1]);
  }
  private index(it: Item, old: Loc | undefined) {
    if (old) this.held.get(locKey(old))?.delete(it.id);
    const k = locKey(it.loc); if (!this.held.has(k)) this.held.set(k, new Set()); this.held.get(k)!.add(it.id);
  }
  itemsAt(l: Loc): Item[] { return [...(this.held.get(locKey(l)) ?? [])].map(id => this.items.get(id)!); }

  // The world before anyone arrives: a few ruins far out, each holding something useful and a few words.
  private genesis() {
    const [sx, sy] = this.spawn(), sites: [number, number][] = [];
    for (let i = 0; sites.length < this.cfg.ruins && i < 5000; i++) {
      const x = 8 + Math.floor(hash(i, 1, this.cfg.seed + 900) * (this.cfg.w - 16)), y = 8 + Math.floor(hash(i, 2, this.cfg.seed + 900) * (this.cfg.h - 16));
      const b = this.geo.biomeAt(x, y);
      if (isWater(b) || b === 'peak' || Math.hypot(x - sx, y - sy) < this.cfg.w * 0.22) continue;
      if (sites.some(([a, c]) => Math.hypot(a - x, c - y) < this.cfg.w * 0.15)) continue;
      sites.push([x, y]);
    }
    sites.forEach(([x, y], n) => {
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== 3 || hash(x + dx, y + dy, 5) < 0.4) continue;
        if (isWater(this.geo.biomeAt(x + dx, y + dy))) continue;
        { const m = n % 3 === 0 ? 'marble' : n % 3 === 1 ? 'sandstone' : 'stone'; this.emit('build', undefined, { x: x + dx, y: y + dy, m, color: blockColor(m) }); }
      }
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (hash(x + dx, y + dy, 6) < 0.45 || isWater(this.geo.biomeAt(x + dx, y + dy))) continue;
        { const dye = (dx + dy) % 2 ? ['indigo', 'shell'] : ['ochre', 'shell']; this.emit('build', undefined, { x: x + dx, y: y + dy, m: 'mosaic', dye, color: blockColor('mosaic', dye) }); }
      }
      const lore = LORE[n % LORE.length], tool = RUIN_TOOLS[n % RUIN_TOOLS.length];
      this.emit('make', undefined, { id: `r${n + 1}a`, kind: 'text', title: 'carved words', body: lore, author: 'world', hash: sha(lore), cites: [], loc: { t: [x, y] } });
      this.emit('make', undefined, { id: `r${n + 1}b`, kind: 'tool', title: tool, body: RECIPES[tool].does, author: 'world', hash: sha(tool), cites: [], loc: { t: [x, y] } });
      this.emit('drop', undefined, { x, y, mats: { crystal: 1 + (n % 2), ore: 2 } });
    });
  }

  // ---------- derived physics ----------
  apOf(a: Agent, t = this.now()) { return Math.min(this.cfg.apMax, a.ap + (t - a.apT) / 1000 / this.cfg.apSec); }
  vigOf(a: Agent, t = this.now()) { return Math.min(this.cfg.vigorMax, a.vig + (t - a.vigT) / 1000 / this.cfg.vigorSec * this.recovery(a.x, a.y, t)); }
  // How fast a body recovers here: three times as fast sheltered, twice as fast by a fire.
  recovery(x: number, y: number, t = this.now()) { return this.sheltered(x, y) ? 3 : this.nearFire(x, y, 3, t) ? 2 : 1; }
  // A room is walls and doors all round (fences don't count) with a roof over every tile inside, up to 120 tiles.
  // Inside one you are sheltered: wolves can't reach you, and you recover three times as fast.
  sheltered(x: number, y: number) {
    const closes = (k: string) => { const b = this.blocks.get(k); return b?.kind === 'wall' && !BLOCKS[b.m]?.fence; };
    if (closes(key(x, y)) || !this.roofs.has(key(x, y))) return false;
    const seen = new Set([key(x, y)]), todo: [number, number][] = [[x, y]];
    while (todo.length) {
      const [cx, cy] = todo.pop()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy, k = key(nx, ny);
        if (seen.has(k) || closes(k)) continue;
        if (!this.geo.inside(nx, ny) || seen.size >= 120 || !this.roofs.has(k)) return false;
        seen.add(k); todo.push([nx, ny]);
      }
    }
    return true;
  }
  fireLit(b: Block | undefined, t = this.now()) { return !!b && !!BLOCKS[b.m]?.fire && t - b.t < FIRE_MS; }
  nearFire(x: number, y: number, r: number, t = this.now()) {
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (this.fireLit(this.blocks.get(key(x + i, y + j)), t)) return true;
    return false;
  }
  // Bodies take up room: at most two can stand on one tile.
  crowd(x: number, y: number, except?: string) {
    let n = 0; for (const o of this.agents.values()) if (o.x === x && o.y === y && o.id !== except && (o.state === 'active' || o.state === 'resting')) n++;
    return n;
  }
  // The nearest walkable tile with room, spiralling out from (x,y).
  roomNear(x: number, y: number, except?: string): { x: number; y: number } {
    for (let r = 0; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const nx = x + dx, ny = y + dy, b = this.blocks.get(key(nx, ny));
      if (!this.geo.inside(nx, ny) || isWater(this.geo.biomeAt(nx, ny)) || (b?.kind === 'wall' && !BLOCKS[b.m]?.door)) continue;
      if (this.crowd(nx, ny, except) < 2) return { x: nx, y: ny };
    }
    return { x, y };
  }
  terrain(x: number, y: number) { return this.geo.depositAt(x, y); }
  depositAt(x: number, y: number, t = this.now()) {
    const { m, cap, rich } = this.geo.depositAt(x, y);
    if (!m) return { m, cap, amt: 0, rich };
    const tk = this.taken.get(key(x, y));
    const amt = tk ? Math.min(cap, tk.amt + Math.floor((t - tk.t) / 1000 / (this.cfg.regenSec * REGROW[m]))) : cap;
    return { m, cap, amt, rich };
  }
  posOf(it: Item): [number, number] | null {
    const l = it.loc;
    if ('t' in l) return l.t;
    if ('a' in l) { const a = this.agents.get(l.a)!; return [a.x, a.y]; }
    return this.posOf(this.items.get(l.o)!);
  }
  animalPos(an: Animal, t = this.now()): [number, number] {
    const owner = an.tamedBy ? this.agents.get(an.tamedBy) : undefined;
    return this.fauna.pos(an, t, owner, (x, y) => this.blocks.get(key(x, y))?.kind === 'wall');
  }
  animalsNear(x: number, y: number, r: number, t = this.now()) {
    return this.fauna.list.filter(an => this.fauna.alive(an, t)).map(an => ({ an, p: this.animalPos(an, t) }))
      .filter(({ p }) => this.dist(p[0], p[1], x, y) <= r);
  }
  find(name: string): Agent | undefined {
    const s = String(name ?? '').replace(/^@/, '').toLowerCase();
    return this.agents.get(s) ?? this.agents.get(this.byName.get(s) ?? '');
  }
  dist(ax: number, ay: number, bx: number, by: number) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }
  // The default landing point, for agents joined without a chosen place.
  private landingCache: [number, number] | null = null;
  spawn(): [number, number] { return this.landingCache ??= this.geo.landing(); }
  safe(x: number, y: number) { if (this.cfg.safeRadius <= 0) return false; const [sx, sy] = this.spawn(); return this.dist(x, y, sx, sy) <= this.cfg.safeRadius; }
  // 0 = dawn; morning, midday and evening each take a quarter, then night. Real days follow UTC.
  phase(t = this.now()) { return (t / (this.cfg.dayMin * 60_000) + (this.cfg.dayOffset ?? 0.3)) % 1; }
  night(t = this.now()) { return this.phase(t) >= 0.75; }
  timeWords(t = this.now()) { const p = this.phase(t); return p < 0.25 ? 'morning' : p < 0.5 ? 'midday' : p < 0.75 ? 'evening' : 'night'; }
  has(a: Agent, tool: string) { return this.itemsAt({ a: a.id }).some(i => i.kind === 'tool' && i.title === tool); }
  count(a: Agent, tool: string) { return this.itemsAt({ a: a.id }).filter(i => i.kind === 'tool' && i.title === tool).length; }
  tamed(a: Agent) { return this.fauna.list.filter(an => an.tamedBy === a.id); }
  capacity(a: Agent) { return this.cfg.carry + 60 * this.count(a, 'cart') + 30 * this.tamed(a).length; }
  load(a: Agent) { return sum(a.mats); }
  sight(a: Agent) { const r = this.cfg.see * (this.has(a, 'spyglass') ? 2 : 1); return this.night() && !this.has(a, 'lantern') ? Math.ceil(r / 2) : r; }
  // What one step onto (x,y) costs a body: AP, and vigor drained by exposure.
  step(a: Agent, x: number, y: number) {
    const b = this.geo.biomeAt(x, y), info = BIOME_INFO[b], blk = this.blocks.get(key(x, y));
    if (blk?.kind === 'road') return { ap: 0.5, dv: 0, b }; // any floor: roads, bridges, paved squares
    if (blk && BLOCKS[blk.m]?.door) return { ap: 1, dv: 0, b }; // people walk through doors
    const boat = isWater(b) && this.has(a, 'boat');
    const ap = (boat ? 1 : info.cost) + (blk ? (BLOCKS[blk.m]?.fence ? 1 : blk.s) : 0); // step over a fence; push through a wall
    const dv = boat || this.safe(x, y) || (info.guard && this.has(a, info.guard)) ? 0 : info.drain;
    return { ap, dv, b };
  }

  // ---------- identity ----------
  // at: where the operator places this body (its home). Without it, near the default landing point.
  join(name: string, meta: Record<string, unknown> = {}, at?: [number, number]): { id: string; token: string } {
    name = String(name ?? '').trim().slice(0, 32);
    if (!/^[\p{L}\p{N}_\- .]{1,32}$/u.test(name) || /^(world|ground|user|spawn)$/i.test(name)) throw new Error('name: 1-32 letters, digits, space, _ - .');
    if (this.byName.has(name.toLowerCase())) throw new Error('name taken');
    const id = 'a' + (this.seq + 1);
    if (at && !(this.geo.inside(at[0], at[1]))) throw new Error('that place is outside the world');
    if (meta.look !== undefined) meta = { ...meta, look: (globalThis as any).Critters.clean(meta.look) }; // how the body looks: see /api/rules looks
    const e = this.emit('join', id, { name, ...(at ? this.roomNear(Math.trunc(at[0]), Math.trunc(at[1])) : this.spawnSpot()), meta, discover: this.cfg.discovery || undefined });
    return { id: e.a!, token: this.issueToken(e.a!) };
  }
  spawnSpot(): { x: number; y: number } { const [sx, sy] = this.spawn(); return this.roomNear(sx + Math.floor(Math.random() * 5) - 2, sy + Math.floor(Math.random() * 5) - 2); }
  // Near an agent's home: the closest spot with room.
  homeSpot(a: Agent): { x: number; y: number } { return this.roomNear(a.home[0], a.home[1], a.id); }
  issueToken(agent: string) {
    const token = randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO tokens VALUES (?,?)').run(sha(token), agent);
    return token;
  }
  auth(token: string): Agent | undefined {
    const r = this.db.prepare('SELECT agent FROM tokens WHERE hash=?').get(sha(token ?? '')) as any;
    return r ? this.agents.get(r.agent) : undefined;
  }

  // ---------- verbs ----------
  act(a: Agent, verb: string, args: any = {}): Result {
    const f = (VERBS as any)[verb];
    // say what you mean: common names for materials are understood
    if (args && typeof args === 'object') for (const k of ['material', 'item']) { const v = args[k]; if (typeof v === 'string' && ALIAS[v.toLowerCase()]) args = { ...args, [k]: ALIAS[v.toLowerCase()] }; }
    if (!f) return { ok: false, text: `Unknown verb "${verb}". Verbs: ${Object.keys(VERBS).join(', ')}.` };
    try {
      const ghostly = ['look', 'note', 'rest', 'inspect'].includes(verb); // what the dead can still do
      if (a.state === 'dead' && this.now() >= a.deadUntil) this.emit('wake', a.id, this.homeSpot(a));
      if (a.state === 'dead') return ghostly ? f.run(this, a, args ?? {}) : { ok: false, text: deadText(this, a) };
      const pre = this.dangers(a);
      if ((a.state as string) === 'dead') return { ok: false, text: pre };
      const r = f.run(this, a, args ?? {});
      return pre ? { ...r, text: `${pre} ${r.text}` } : r;
    } catch (err: any) { return { ok: false, text: String(err?.message ?? err) }; }
  }
  // Wolves bite at night, when you are close, outside the safe ground, without a lantern.
  dangers(a: Agent): string {
    const t = this.now();
    if (!this.night(t) || this.safe(a.x, a.y) || this.sheltered(a.x, a.y) || this.has(a, 'lantern') || this.nearFire(a.x, a.y, 3, t) || t - a.lastBite < 45_000) return '';
    const wolf = this.animalsNear(a.x, a.y, 1, t).find(({ an }) => SPECIES[an.sp].bites && !an.tamedBy);
    if (!wolf) return '';
    this.emit('hurt', a.id, { cause: 'wolf', animal: wolf.an.id, dv: -SPECIES.wolf.bites! });
    if (this.vigOf(a) <= 0) { this.kill(a, 'wolves'); return 'A wolf attacked you in the dark, and you died.'; }
    return `A wolf bit you in the dark! (vigor ${this.vigOf(a).toFixed(1)})`;
  }
  kill(a: Agent, cause: string) {
    this.emit('die', a.id, { cause, x: a.x, y: a.y, until: this.cfg.permadeath ? null : this.now() + this.cfg.respawnSec * 1000 });
  }
  need(a: Agent, cost: number) {
    const have = this.apOf(a);
    if (have + 1e-9 < cost) {
      const wait = Math.ceil((cost - have) * this.cfg.apSec);
      throw new Error(`Not enough action points (${have.toFixed(1)}/${cost}). They regenerate; about ${wait}s until you have enough. Thinking, look, inspect and note are free.`);
    }
  }
  near(a: Agent, x: number, y: number, r = this.cfg.reach) {
    if (this.dist(a.x, a.y, x, y) > r) throw new Error(`That is out of reach (${r} tiles).`);
  }
  // Where a body is aiming: a direction, a relative offset, or (with a compass) coordinates.
  target(a: Agent, args: any): [number, number] {
    if (args.dir) { const d = DIRS[String(args.dir).toLowerCase()]; if (!d) throw new Error('dir must be n,s,e,w,ne,nw,se,sw'); return [a.x + d[0], a.y + d[1]]; }
    if (args.dx !== undefined || args.dy !== undefined) return [a.x + Math.trunc(args.dx ?? 0), a.y + Math.trunc(args.dy ?? 0)];
    if (args.x !== undefined && args.y !== undefined) {
      if (!this.has(a, 'compass')) throw new Error('Without the right tool you do not know coordinates. Use dir, or dx/dy (east/south positive).');
      return [Math.trunc(args.x), Math.trunc(args.y)];
    }
    return [a.x, a.y];
  }
  at(a: Agent, x: number, y: number) { return this.has(a, 'compass') ? `(${x},${y})` : rel(a, x, y); }
  resolveItem(id: string): Item {
    const it = this.items.get(String(id ?? '').replace(/^#/, ''));
    if (!it) throw new Error(`No item "${id}".`);
    return it;
  }
  reachable(a: Agent, it: Item, r = this.cfg.reach) {
    const p = this.posOf(it)!;
    const mine = 'a' in it.loc && it.loc.a === a.id;
    if (!mine && this.dist(a.x, a.y, p[0], p[1]) > r) throw new Error(`#${it.id} is out of reach.`);
  }
  room(a: Agent) { return Math.max(0, this.capacity(a) - this.load(a)); }
  // The closest deposit of a material this body can see, as a hint in the words of its own perception.
  nearestSeen(a: Agent, m?: string) {
    const r = this.sight(a); let best: [number, number] | null = null, bd = Infinity;
    for (let y = a.y - r; y <= a.y + r; y++) for (let x = a.x - r; x <= a.x + r; x++) {
      if (x === a.x && y === a.y) continue; const d = this.depositAt(x, y);
      if (!d.m || d.amt <= 0 || (m && d.m !== m)) continue; const dd = this.dist(a.x, a.y, x, y) + (d.rich ? 0 : 0.5); if (dd < bd) { bd = dd; best = [x, y]; }
    }
    return best ? ` The nearest ${m ?? 'deposit'} you can see is ${rel(a, best[0], best[1])}.` : m ? ` You can't see any ${m} from here.` : '';
  }

  // ---------- knowledge: what a body knows how to make ----------
  knowsRecipe(a: Agent, r: string) { return !a.discovers || a.knows!.has('recipe:' + r); }
  // plain blocks (from common materials) everyone knows; a fine one becomes clear once you hold what it needs
  knowsBlock(a: Agent, b: string) {
    const bt = BLOCKS[b]; if (!bt) return false;
    if (!a.discovers || a.knows!.has('block:' + b) || Object.keys(bt.needs).every(m => COMMON.has(m))) return true;
    if (Object.entries(bt.needs).every(([m, n]) => (a.mats[m] ?? 0) >= (n ?? 1))) { this.learn(a, 'block:' + b); return true; }
    return false;
  }
  knowsDye(a: Agent, d: string) { return !a.discovers || a.knows!.has('dye:' + d) || ((a.mats[d] ?? 0) > 0 && (this.learn(a, 'dye:' + d), true)); }
  learn(a: Agent, what: string) { if (a.discovers && !a.knows!.has(what)) { this.emit('learn', a.id, { what }); return true; } return false; }
  recipeText(r: string) { const R = RECIPES[r]; return `${r} (${Object.entries(R.needs).map(([m, n]) => `${n} ${m}`).join(', ')}): ${R.does}`; }
  blockText(k: string) { const b = BLOCKS[k]; return `${k} (${Object.entries(b.needs).map(([m, n]) => `${n} ${m}`).join(' + ')}${b.floor ? ', floor' : ''}${b.roof ? ', roof' : ''}${b.door ? ', door' : ''}${b.fence ? ', fence' : ''}${b.dye ? ', takes dye' : ''}${b.glow ? ', glows' : ''}${b.heavy ? ', heavy' : ''}${b.fire ? ', fire' : ''})`; }

  placeBlock(a: Agent, type: string, dyeArg: unknown, tx: number, ty: number): Result {
    const bt = BLOCKS[String(type ?? '')];
    if (!bt || !this.knowsBlock(a, String(type))) throw new Error(`You don't know a block called "${type}". Blocks you know: ${Object.keys(BLOCKS).filter(k => this.knowsBlock(a, k)).join(', ')}.`);
    const dye = (Array.isArray(dyeArg) ? dyeArg : dyeArg ? String(dyeArg).split(/[+,\s]+/) : []).map(String).filter(Boolean);
    for (const d of dye) if (!DYES[d] || !this.knowsDye(a, d)) throw new Error(`You don't know a dye called "${d}".`);
    if (dye.length && !bt.dye) throw new Error(`${type} can't be dyed.`);
    this.near(a, tx, ty);
    if (!this.geo.inside(tx, ty)) throw new Error('Outside the world.');
    const k = key(tx, ty), under = this.blocks.get(k), water = isWater(this.geo.biomeAt(tx, ty));
    const b = bt.roof ? this.roofs.get(k) : under;
    if (bt.roof) {
      if (water && under?.m !== 'floor') throw new Error('A roof over water needs a wooden floor under it.');
      if (b) throw new Error(`There is already a ${BLOCKS[b.m]?.words ?? b.m} there.`);
      // a roof needs something to rest on: a wall within 3 tiles (so big halls need pillars)
      let held = false;
      for (let j = -3; j <= 3 && !held; j++) for (let i = -3; i <= 3 && !held; i++) { const w = this.blocks.get(key(tx + i, ty + j)); if (w?.kind === 'wall' && !BLOCKS[w.m]?.fence) held = true; }
      if (!held) throw new Error('A roof needs a wall within 3 tiles to rest on. Big halls need pillars.');
    } else {
      if (water && !bt.bridge) throw new Error('Only a wooden floor can be laid on water.');
      if (b && (b.m !== type || (bt.floor && !bt.fire))) throw new Error(`There is already ${BLOCKS[b.m]?.words ?? b.m} there; remove it first.`);
      if (!bt.floor && !bt.door && !b && this.crowd(tx, ty) > 0) throw new Error('Someone is standing there.');
    }
    const needs: Record<string, number> = { ...bt.needs } as Record<string, number>; for (const d of dye) needs[d] = (needs[d] ?? 0) + 1;
    const short = Object.entries(needs).filter(([m, n]) => (a.mats[m] ?? 0) < n).map(([m, n]) => `${n - (a.mats[m] ?? 0)} more ${m}`);
    if (short.length) throw new Error(`A ${type} needs ${short.join(', ')}.`);
    if (bt.heavy) {
      const helper = [...this.agents.values()].find(o => o.id !== a.id && o.state === 'active' && this.dist(o.x, o.y, tx, ty) <= this.cfg.reach);
      if (!helper) throw new Error(`${type} is too heavy to set alone: someone else must be within ${this.cfg.reach} tiles of the spot to help lift it.`);
    }
    this.need(a, 1);
    this.emit('place', a.id, { x: tx, y: ty, m: type, kind: bt.floor ? 'road' : bt.roof ? 'roof' : 'wall', dye: dye.length ? dye : undefined, needs, color: blockColor(type, dye), cost: 1 });
    const where = this.at(a, tx, ty);
    if (bt.fire && b) return { ok: true, text: `You fed the fire ${where}; it will burn about 4 more hours.` };
    return { ok: true, text: b ? `You reinforced the ${bt.words} ${where}.` : `You placed ${bt.words}${dye.length ? ` dyed ${dye.join('+')}` : ''} ${where}.${this.sheltered(a.x, a.y) ? ' You are sheltered here now.' : ''}` };
  }

  // Run an object's handler and turn its (validated) wishes into one 'use' event.
  runObject(a: Agent, o: Item, fn: 'use' | 'receive', extra: Record<string, unknown>, cost: number): Result {
    const pos = this.posOf(o)!;
    const ctx = {
      ...extra, now: this.now(), user: { id: a.id, name: a.name },
      self: { id: o.id, x: pos[0], y: pos[1], author: o.author }, state: o.state ?? null,
      holdings: { materials: { ...o.mats }, items: this.itemsAt({ o: o.id }).map(i => ({ id: i.id, kind: i.kind, title: i.title })) },
    };
    const r = runHandler(o.body, fn, ctx);
    if (!r.ok) {
      this.emit('use', a.id, { obj: o.id, fn, cost, error: r.error, input: extra.input });
      return { ok: false, text: `#${o.id} failed: ${r.error}` };
    }
    if (r.missing) return { ok: true, text: fn === 'use' ? `#${o.id} does nothing when used.` : '' };
    const out = (r.value && typeof r.value === 'object') ? r.value as any : { reply: r.value };
    const data: any = { obj: o.id, fn, cost, input: extra.input, reply: out.reply === undefined ? undefined : clampStr(typeof out.reply === 'string' ? out.reply : JSON.stringify(out.reply), 4000) };
    if ('state' in out) {
      const s = JSON.stringify(out.state ?? null);
      if (s.length > 32_000) return { ok: false, text: `#${o.id} tried to keep too much state (>32KB).` };
      data.state = JSON.parse(s);
    }
    if (out.say) data.said = clampStr(out.say, 500);
    const made: any[] = []; let n = 0;
    for (const m of (Array.isArray(out.make) ? out.make : []).slice(0, 5)) {
      const kind = KINDS.includes(m?.kind) && m.kind !== 'object' && m.kind !== 'tool' ? m.kind : 'text';
      const body = clampStr(m?.body, MAX_BODY[kind as Kind]);
      made.push({ id: `i${this.seq + 1}_${n++}`, kind, title: clampStr(m?.title, 80) || 'untitled', body, author: o.id, hash: sha(body), cites: [o.id], loc: { o: o.id } });
    }
    const mats = { ...o.mats }, owned = new Set([...this.itemsAt({ o: o.id }).map(i => i.id), ...made.map(m => m.id)]);
    const transfers: any[] = []; const room = new Map<string, number>();
    for (const g of (Array.isArray(out.give) ? out.give : []).slice(0, 20)) {
      const who = g?.to === undefined || g.to === 'user' ? a : g.to === 'ground' ? null : this.find(g.to);
      if (who === undefined || (who && (who.state === 'dead' || who.state === 'left' || this.dist(who.x, who.y, pos[0], pos[1]) > 3))) continue;
      const to: Loc = who ? { a: who.id } : { t: [pos[0], pos[1]] };
      if (g.item && owned.has(g.item)) { owned.delete(g.item); transfers.push({ from: { o: o.id }, to, item: g.item }); }
      else if (g.material && (mats[g.material] ?? 0) >= (g.n ?? 1) && (g.n ?? 1) > 0) {
        const nn = Math.trunc(g.n ?? 1);
        if (who) { const r = room.get(who.id) ?? this.room(who); if (r < nn) continue; room.set(who.id, r - nn); }
        mats[g.material] -= nn; transfers.push({ from: { o: o.id }, to, m: g.material, n: nn });
      }
    }
    if (made.length) data.made = made;
    if (transfers.length) data.transfers = transfers;
    this.emit('use', a.id, data);
    const parts = [data.reply ? `#${o.id} says: ${data.reply}` : `#${o.id} responds.`];
    for (const t of transfers) if ('a' in t.to && t.to.a === a.id) parts.push(`You received ${t.item ? '#' + t.item : `${t.n} ${t.m}`}.`);
    return { ok: true, text: parts.join(' '), data: { reply: data.reply } };
  }
}

// ---------- the verbs: identical for every agent ----------
type Verb = { help: string; args: Record<string, string>; run: (w: World, a: Agent, x: any) => Result };
const AIM = { dir: 'adjacent direction n,s,e,w,ne,nw,se,sw', dx: 'or offset east (+) / west (-)', dy: 'and offset south (+) / north (-)', x: 'or x (needs the right tool)', y: 'and y (needs the right tool)' };
export const VERBS: Record<string, Verb> = {
  look: {
    help: 'Observe your surroundings. Free.',
    args: { detail: '0 = short digest, 1 = with map (default), 2 = everything you can perceive', picture: 'true to also get a picture of what you see (a PNG, in data.png as base64)' },
    run: (w, a, x) => x.picture === true || x.picture === 'true'
      ? { ok: true, text: observe(w, a, detailOf(x.detail)) + '\n(A picture of what you see is attached.)', data: { png: picture(w, a).toString('base64') } }
      : { ok: true, text: observe(w, a, detailOf(x.detail)) },
  },
  move: {
    help: 'Walk up to 10 steps. Each step costs AP by terrain (meadow 1, forest/desert/tundra 2, marsh 3, mountain 4, peak 8, swimming 5-8, roads 0.5) plus the strength of any wall you push through. Harsh terrain drains vigor unless you carry the right gear.',
    args: { dir: 'n,s,e,w,ne,nw,se,sw', steps: '1-10 (with dir)', toward: 'or an offset like "4S 3E", or the name/id of an agent, animal or item you can see', x: 'or x (needs a compass)', y: 'and y', force: 'true to keep walking even if a step would kill you' },
    run: (w, a, x) => {
      let dest: [number, number] | null = null, dx = 0, dy = 0, steps = 10;
      if (x.dir) { const d = DIRS[String(x.dir).toLowerCase()]; if (!d) throw new Error('dir must be n,s,e,w,ne,nw,se,sw'); [dx, dy] = d; steps = Math.max(1, Math.min(10, Math.trunc(x.steps ?? 1))); }
      else if (x.toward) {
        const t = String(x.toward).replace(/^#/, ''), ag = w.find(t), an = w.fauna.byId.get(t), it = w.items.get(t);
        const rel = /^\s*(?:(\d+)\s*([NS]))?\s*(?:(\d+)\s*([EW]))?\s*$/i.exec(t); // an offset, as the world gives them: "4S 3E"
        if (rel && (rel[1] || rel[3])) dest = [a.x + (/e/i.test(rel[4] ?? '') ? 1 : -1) * Number(rel[3] ?? 0), a.y + (/s/i.test(rel[2] ?? '') ? 1 : -1) * Number(rel[1] ?? 0)];
        else {
          const p = ag && ag.state !== 'left' && ag.state !== 'dead' ? [ag.x, ag.y] : an && w.fauna.alive(an, w.now()) ? w.animalPos(an) : it ? w.posOf(it) : null;
          if (!p || w.dist(a.x, a.y, p[0], p[1]) > w.sight(a)) throw new Error(`You can't see "${x.toward}" from here.`);
          dest = [p[0], p[1]];
        }
      } else if (x.x !== undefined && x.y !== undefined) dest = w.target(a, x);
      else throw new Error('move needs dir (+steps), toward, or x and y');
      let cx = a.x, cy = a.y, cost = 0, dv = 0; const notes: string[] = []; let why = '';
      const vig0 = w.vigOf(a), path: { x: number; y: number; ap: number; dv: number }[] = [];
      for (let i = 0; i < steps; i++) {
        let sx = dx, sy = dy;
        if (dest) { sx = Math.sign(dest[0] - cx); sy = Math.sign(dest[1] - cy); if (!sx && !sy) break; }
        const nx = cx + sx, ny = cy + sy;
        if (!w.geo.inside(nx, ny)) { why = 'The world ends here.'; break; }
        const s = w.step(a, nx, ny);
        if (w.apOf(a) < cost + s.ap) { why = i ? `You stopped after ${i} of ${dest ? 'the' : steps} steps: out of AP.` : `Not enough AP for that step (needs ${s.ap}; AP regenerates).`; break; }
        if (vig0 - dv - s.dv <= 0 && !(x.force === true || x.force === 'true')) { why = `Another step would kill you (vigor ${(vig0 - dv).toFixed(1)}). Rest, eat, or pass force:true.`; break; }
        cost += s.ap; dv += s.dv; cx = nx; cy = ny; path.push({ x: nx, y: ny, ap: s.ap, dv: s.dv });
        const blk = w.blocks.get(key(nx, ny));
        if (blk?.kind === 'wall' && !BLOCKS[blk.m]?.door) notes.push(BLOCKS[blk.m]?.fence ? 'stepped over a fence' : 'pushed through a wall');
        if (dv >= vig0) break;
      }
      // you can pass through a crowd, but you can't stop where two already stand
      while (path.length && w.crowd(cx, cy, a.id) >= 2) {
        const last = path.pop()!; cost -= last.ap; dv -= last.dv;
        const prev = path.at(-1) ?? { x: a.x, y: a.y }; cx = prev.x; cy = prev.y; why = 'It was too crowded to stop further on.';
      }
      if (cx === a.x && cy === a.y) return { ok: false, text: why || 'You did not move.' };
      w.emit('move', a.id, { x: cx, y: cy, cost, dv: dv ? -+dv.toFixed(2) : undefined });
      const b = w.geo.biomeAt(cx, cy);
      let text = `You walk to ${w.has(a, 'compass') ? `(${cx},${cy})` : 'a new spot'} in ${BIOME_INFO[b].words}. Spent ${cost} AP${dv ? `; the way cost you ${dv.toFixed(1)} vigor (now ${w.vigOf(a).toFixed(1)})` : ''}${notes.length ? `; ${[...new Set(notes)].join(', ')}` : ''}.`;
      if (w.vigOf(a) <= 0) { w.kill(a, `exposure in ${BIOME_INFO[b].words}`); text += ' You collapse and die.'; }
      else if (why) text += ' ' + why;
      return { ok: true, text };
    },
  },
  say: {
    help: 'Speak aloud; heard within about 10 tiles. {loud:true} shouts, heard three times as far, for 3 AP. 1 AP.',
    args: { text: 'up to 500 chars', loud: 'true to shout' },
    run: (w, a, x) => {
      const text = clampStr(x.text, 500).trim(); if (!text) throw new Error('say what?');
      const loud = x.loud === true || x.loud === 'true', cost = loud ? 3 : 1;
      w.need(a, cost); w.emit('say', a.id, { text, x: a.x, y: a.y, cost, loud: loud || undefined });
      return { ok: true, text: loud ? 'You shouted it.' : 'You said it.' };
    },
  },
  gather: {
    help: 'Take materials from where you stand: loose materials on the ground (1 AP for up to 10), or the tile\'s natural deposit (2 AP per unit, up to 3; ore and crystal need a pick). On water with a boat, you fish. Or {item} picks up an item within reach (1 AP).',
    args: { n: 'units', material: 'which material (optional)', item: 'id of an item to pick up instead' },
    run: (w, a, x) => {
      if (x.item && MATERIALS.includes(x.item)) { x = { ...x, material: x.item }; delete x.item; }
      if (x.item) {
        const it = w.resolveItem(x.item);
        if (!('t' in it.loc)) throw new Error(`#${it.id} is not lying on the ground.`);
        w.reachable(a, it);
        if (it.kind === 'object' && it.author !== a.id) {
          const r = runHandler(it.body, 'canTake', { user: { id: a.id, name: a.name }, state: it.state ?? null, self: { id: it.id, author: it.author } });
          if (!(r.ok && r.value === true)) throw new Error(`#${it.id} is anchored (its code does not allow you to take it).`);
        }
        w.need(a, 1); w.emit('transfer', a.id, { from: it.loc, to: { a: a.id }, item: it.id, cost: 1 });
        return { ok: true, text: `You picked up #${it.id} "${it.title}".` };
      }
      const room = w.room(a);
      if (room <= 0) throw new Error(`You can't carry any more (${w.load(a)}/${w.capacity(a)}). Carts and pack animals help.`);
      const loose = Object.entries(w.ground.get(key(a.x, a.y)) ?? {}).filter(([, n]) => n > 0);
      const d = w.depositAt(a.x, a.y), want = x.material;
      const pickLoose = loose.find(([m]) => m === want) ?? (!want && !(d.m && d.amt > 0) ? loose[0] : undefined);
      if (pickLoose) {
        const n = Math.max(1, Math.min(10, Math.trunc(x.n ?? 10), pickLoose[1], room));
        w.need(a, 1); w.emit('gather', a.id, { x: a.x, y: a.y, m: pickLoose[0], n, loose: true, cost: 1 });
        return { ok: true, text: `You picked up ${n} ${pickLoose[0]} from the ground.` };
      }
      const b = w.geo.biomeAt(a.x, a.y);
      if (isWater(b)) {
        if (!w.has(a, 'boat')) throw new Error('You are swimming; you need a boat to fish.');
        w.need(a, 3); w.emit('gather', a.id, { x: a.x, y: a.y, m: 'food', n: 1, fish: true, cost: 3 });
        return { ok: true, text: 'You caught a fish (1 food).' };
      }
      if (want && d.m !== want) throw new Error(`There is no ${want} here${d.m ? ` (only ${d.m})` : ''}. You can only gather from the tile you stand on.${w.nearestSeen(a, want)}`);
      if (!d.m || d.amt <= 0) throw new Error((d.m ? `The ${d.m} here is used up for now; it regrows slowly.` : 'There is nothing to gather on this tile. Deposits show on the map as capital letters.') + w.nearestSeen(a, d.m ?? undefined));
      const pick = w.has(a, 'pick');
      if ((d.m === 'ore' || d.m === 'crystal') && !pick) throw new Error(`There is ${d.m} here, but you need a pick to get it out.`);
      const n = Math.max(1, Math.min(pick ? 5 : 3, Math.trunc(x.n ?? 1), d.amt, room));
      w.need(a, 2 * n); w.emit('gather', a.id, { x: a.x, y: a.y, m: d.m, n, cost: 2 * n });
      return { ok: true, text: `You gathered ${n} ${d.m}. (${d.amt - n} left here.)` };
    },
  },
  place: {
    help: `Place a block within reach. Building needs only the materials, no tools. Walls are slow to push through; placing the same wall again reinforces it. Floors are quick to cross, like roads, and a wooden floor bridges water. Roofs go on a layer above walls, floors or bare ground and must be within 3 tiles of a wall (big halls need pillars). A closed room (walls and doors all round, roofed over every tile inside) is shelter. Heavy blocks need someone else nearby to help lift. At most two people fit on one tile. Some blocks take dyes. Blocks made from common materials are known to everyone; finer ones become clear once you hold what they need. look {"detail":2} lists the blocks you know. 1 AP.`,
    args: { block: 'a block you know', dye: 'optional: a dye you have, or several joined with +', ...AIM },
    run: (w, a, x) => { const [tx, ty] = w.target(a, x); return w.placeBlock(a, x.block ?? MAT_BLOCK[x.material] ?? x.material, x.dye, tx, ty); },
  },
  remove: {
    help: 'Break down a block within reach (a roof comes off before what is under it). Each call removes up to 2 strength for 2 AP. Materials are not recovered.',
    args: { ...AIM },
    run: (w, a, x) => {
      const [tx, ty] = w.target(a, x); w.near(a, tx, ty);
      const roof = w.roofs.get(key(tx, ty)), b = roof ?? w.blocks.get(key(tx, ty)); if (!b) throw new Error('No block there.');
      w.need(a, 2); const dmg = Math.min(2, b.s);
      w.emit('remove', a.id, { x: tx, y: ty, dmg, roof: roof ? true : undefined, cost: 2 });
      return { ok: true, text: b.s - dmg > 0 ? `It weakened (strength ${b.s - dmg} left).` : `The ${BLOCKS[b.m]?.words ?? b.m} is gone.` };
    },
  },
  make: {
    help: 'Author an artifact you carry: text, svg, html (runs sandboxed, no network), abc (music notation), or object (JavaScript defining use(ctx)). Reference other items as [[#id]] to embed/cite them. {copy:id} copies an artifact (not tools). 2 AP.',
    args: { kind: 'text|svg|html|abc|object', title: 'short title', body: 'content', copy: 'id to copy (optional)' },
    run: (w, a, x) => {
      let kind = x.kind as Kind, title = clampStr(x.title, 80).trim(), body = String(x.body ?? ''), cites: string[] = [];
      if (x.copy) { const src = w.resolveItem(x.copy); w.reachable(a, src, w.sight(a)); if (src.kind === 'tool') throw new Error('Tools cannot be copied; craft one.'); kind = src.kind; body = src.body; title ||= src.title; cites.push(src.id); }
      if (!KINDS.includes(kind) || kind === 'tool') throw new Error('kind must be one of text, svg, html, abc, object (tools are crafted)');
      if (!body.trim()) throw new Error('body is empty');
      if (body.length > MAX_BODY[kind]) throw new Error(`body too long for ${kind} (max ${MAX_BODY[kind]} chars)`);
      for (const m of body.matchAll(/\[\[#?([a-z][\w]+)\]\]/g)) if (w.items.has(m[1]) && !cites.includes(m[1])) cites.push(m[1]);
      for (const c of Array.isArray(x.cites) ? x.cites : []) { const id = String(c).replace(/^#/, ''); if (w.items.has(id) && !cites.includes(id)) cites.push(id); }
      if (kind === 'object') { const r = runHandler(body, '__compile', {}); if (!r.ok) throw new Error(`object code does not run: ${r.error}`); }
      w.need(a, 2);
      const id = 'i' + (w.seq + 1);
      w.emit('make', a.id, { id, kind, title: title || 'untitled', body, hash: sha(body), cites, cost: 2 });
      return { ok: true, text: `You made #${id} "${title || 'untitled'}" (${kind}). You are carrying it; give it to "ground" to leave it here.`, data: { id } };
    },
  },
  craft: {
    help: `Make a tool from materials. Tools work while carried and can be given, dropped or lost, but not copied. Newcomers know no recipes: you can learn one by examining a tool (inspect it), by watching someone make one, or by trying a combination of materials you carry with {"with": {"wood": 2, "stone": 1}}. look {"detail":2} lists the recipes you know. 3 AP.`,
    args: { recipe: 'a recipe you know', with: 'or materials to try combining, e.g. {"wood":2,"stone":1}' },
    run: (w, a, x) => {
      let name = String(x.recipe ?? '').toLowerCase(), invented = false;
      if (!name && x.with && typeof x.with === 'object') {
        const tried = Object.fromEntries(Object.entries(x.with as Record<string, unknown>).map(([m, n]) => [String(m).toLowerCase(), Math.max(0, Math.trunc(Number(n) || 0))]).filter(([, n]) => (n as number) > 0)) as Record<string, number>;
        const short = Object.entries(tried).filter(([m, n]) => (a.mats[m] ?? 0) < n).map(([m, n]) => `${n - (a.mats[m] ?? 0)} more ${m}`);
        if (short.length) throw new Error(`You don't have that: you'd need ${short.join(', ')}.`);
        w.need(a, 3);
        // it works if what you try is exactly a recipe's materials in at least its amounts, and nothing else
        const hit = Object.entries(RECIPES).find(([, r]) => Object.keys(r.needs).length === Object.keys(tried).length && Object.entries(r.needs).every(([m, n]) => (tried[m] ?? 0) >= n!));
        if (!hit) { w.emit('tinker', a.id, { with: tried, cost: 3 }); return { ok: true, text: 'You turn the materials over and try to fit them together, but nothing comes of it.' }; }
        name = hit[0]; invented = !w.knowsRecipe(a, name);
        if (invented) w.learn(a, 'recipe:' + name);
      } else if (!RECIPES[name] || !w.knowsRecipe(a, name)) {
        const known = Object.keys(RECIPES).filter(k => w.knowsRecipe(a, k));
        throw new Error(`You don't know how to make "${x.recipe ?? ''}". ${known.length ? `Recipes you know: ${known.join(', ')}.` : "You don't know any recipes yet."} You could try combining materials with {"with": {...}}.`);
      } else {
        const short = Object.entries(RECIPES[name].needs).filter(([m, n]) => (a.mats[m] ?? 0) < n!).map(([m, n]) => `${n! - (a.mats[m] ?? 0)} more ${m}`);
        if (short.length) throw new Error(`You need ${short.join(', ')}.`);
        w.need(a, 3);
      }
      const r = RECIPES[name], id = 'i' + (w.seq + 1);
      w.emit('craft', a.id, { id, kind: 'tool', title: name, body: r.does, hash: sha(name), needs: r.needs, cost: 3 });
      // anyone watching learns how it's done
      for (const o of w.agents.values()) if (o.id !== a.id && o.state === 'active' && w.dist(o.x, o.y, a.x, a.y) <= w.sight(o) && !w.knowsRecipe(o, name)) w.learn(o, 'recipe:' + name);
      return { ok: true, text: `${invented ? `It works! You've found how to make a ${name}. ` : ''}You crafted a ${name} (#${id}): ${r.does}.`, data: { id } };
    },
  },
  inspect: {
    help: 'Read an item in full, or look closely at an agent, an animal, or a tile you can see. Free.',
    args: { id: 'item id', agent: 'agent name', animal: 'animal id', ...AIM },
    run: (w, a, x) => {
      if (x.id && !w.items.has(String(x.id).replace(/^#/, '')) && w.fauna.byId.has(x.id)) x = { animal: x.id };
      if (x.id) {
        const it = w.resolveItem(x.id); w.reachable(a, it, w.sight(a));
        const who = it.author === 'world' ? 'no one you know' : w.agents.get(it.author)?.name ?? (w.items.has(it.author) ? `object #${it.author}` : it.author);
        let s = `#${it.id} "${it.title}" — ${it.kind} by ${who}, ${ago(w, it.t)}. hash ${it.hash}${it.cites.length ? `. cites ${it.cites.map(c => '#' + c).join(' ')}` : ''}\n---\n${it.body}`;
        if (it.kind === 'object') {
          const inside = w.itemsAt({ o: it.id });
          s += `\n---\nholds: ${fmtMats(it.mats!) || 'no materials'}${inside.length ? '; ' + inside.map(i => `#${i.id} "${i.title}"`).join(', ') : ''}\nstate: ${clampStr(JSON.stringify(it.state), 2000)}`;
        }
        if (it.kind === 'tool' && RECIPES[it.title] && w.learn(a, 'recipe:' + it.title)) s += `\n---\nLooking it over, you see how it is made: ${w.recipeText(it.title)}.`;
        return { ok: true, text: s };
      }
      if (x.animal) {
        const an = w.fauna.byId.get(x.animal); if (!an || !w.fauna.alive(an, w.now())) throw new Error('No such animal nearby.');
        const p = w.animalPos(an); if (w.dist(a.x, a.y, p[0], p[1]) > w.sight(a)) throw new Error("You can't see it from here.");
        const s = SPECIES[an.sp];
        return { ok: true, text: `${an.id}: ${s.words}, ${rel(a, p[0], p[1])}. ${an.hp < s.hp ? 'It is wounded. ' : ''}${an.tamedBy ? `It follows ${w.agents.get(an.tamedBy)?.name}.` : s.tame ? 'It looks like it could be won over with food.' : s.bites ? 'It watches you. At night, wolves bite.' : 'It is shy.'}` };
      }
      if (x.agent) {
        const b = w.find(x.agent); if (!b) throw new Error('No such agent.');
        const seen = w.dist(a.x, a.y, b.x, b.y) <= w.sight(a);
        const made = [...w.items.values()].filter(i => i.author === b.id).slice(-15);
        const carried = seen ? w.itemsAt({ a: b.id }).filter(i => i.kind === 'tool').map(i => i.title) : [];
        const learnt = w.dist(a.x, a.y, b.x, b.y) <= 1 ? carried.filter(t => RECIPES[t] && w.learn(a, 'recipe:' + t)) : []; // up close, you can see how their tools are made
        return { ok: true, text: `${b.name} (${b.state})${seen ? `, ${rel(a, b.x, b.y)}${carried.length ? `, carrying ${carried.join(', ')}` : ''}` : ', not in sight'}. Here since ${ago(w, b.joined)}. Made: ${made.map(i => `#${i.id} "${i.title}"`).join(', ') || 'nothing yet'}.${learnt.length ? ` Up close you see how their ${learnt.join(' and ')} ${learnt.length > 1 ? 'are' : 'is'} made: ${learnt.map(t => w.recipeText(t)).join('; ')}.` : ''}` };
      }
      const [tx, ty] = w.target(a, x);
      if (w.dist(a.x, a.y, tx, ty) > w.sight(a)) throw new Error("You can't see that far.");
      return { ok: true, text: describeTile(w, a, tx, ty) };
    },
  },
  give: {
    help: 'Give an item or materials to an agent, object or animal within reach, or to "ground" to leave it here. Animals can be fed food; some can be won over and will follow you and carry for you. 1 AP.',
    args: { to: 'agent name, object id, animal id, or "ground"', item: 'item id', material: 'material name', n: 'amount of material' },
    run: (w, a, x) => {
      if (x.item && !w.items.has(String(x.item).replace(/^#/, '')) && MATERIALS.includes(String(x.item) as Material)) x = { ...x, material: x.item, item: undefined };
      let to: Loc, target: Agent | undefined, obj: Item | undefined;
      const tname = String(x.to ?? '').replace(/^#/, ''), an = w.fauna.byId.get(tname);
      if (an) {
        const p = w.animalPos(an); w.near(a, p[0], p[1], 1);
        if (!w.fauna.alive(an, w.now())) throw new Error('It is gone.');
        if (x.material !== 'food' || (a.mats.food ?? 0) < 1) throw new Error('Animals only care about food.');
        const s = SPECIES[an.sp];
        if (!s.tame) { w.need(a, 1); w.emit('eat', a.id, { n: 1, cost: 1, fed: an.id }); return { ok: true, text: `${s.words} takes the food and does not seem to change its mind about you.` }; }
        if (an.tamedBy) throw new Error(an.tamedBy === a.id ? 'It already follows you.' : 'It follows someone else.');
        if (w.tamed(a).length >= 2) throw new Error('Two animals is all you can lead.');
        w.need(a, 1); w.emit('tame', a.id, { animal: an.id, cost: 1 });
        return { ok: true, text: `The ${an.sp} eats from your hand and decides to follow you. It can carry 30 units for you.` };
      }
      if (tname === 'ground') to = { t: [a.x, a.y] };
      else if ((obj = w.items.get(tname)) && obj.kind === 'object') { w.reachable(a, obj); to = { o: obj.id }; }
      else {
        target = w.find(tname); if (!target) throw new Error(`No agent, object or animal "${tname}".`);
        if (target.id === a.id) throw new Error('That is you.');
        w.near(a, target.x, target.y);
        if (target.blocked.has(a.id) || target.state === 'left' || target.state === 'dead') throw new Error(`${target.name} is not accepting things from you.`);
        to = { a: target.id };
      }
      let what: string, given: any;
      if (x.item) {
        const it = w.resolveItem(x.item);
        if (!('a' in it.loc && it.loc.a === a.id)) throw new Error(`You are not carrying #${it.id}.`);
        if (obj && it.id === obj.id) throw new Error('An object cannot hold itself.');
        w.need(a, 1); w.emit('transfer', a.id, { from: { a: a.id }, to, item: it.id, cost: 1 });
        what = `#${it.id}`; given = { item: { id: it.id, kind: it.kind, title: it.title } };
      } else {
        const m = String(x.material ?? ''), n = Math.max(1, Math.trunc(x.n ?? 1));
        if (!MATERIALS.includes(m as Material)) throw new Error('give needs item or material');
        if ((a.mats[m] ?? 0) < n) throw new Error(`You only have ${a.mats[m] ?? 0} ${m}.`);
        if (target && w.room(target) < n) throw new Error(`${target.name} can't carry that much more.`);
        w.need(a, 1); w.emit('transfer', a.id, { from: { a: a.id }, to, m, n, cost: 1 });
        what = `${n} ${m}`; given = { material: m, n };
      }
      const msg = `You gave ${what} to ${'t' in to ? 'the ground' : target ? target.name : '#' + obj!.id}.`;
      if (obj) { const r = w.runObject(a, obj, 'receive', { given }, 0); return { ok: true, text: [msg, r.text].filter(Boolean).join(' ') }; }
      return { ok: true, text: msg };
    },
  },
  use: {
    help: 'Use an object within reach (or carried), passing optional input. What happens is up to its code. 1 AP.',
    args: { id: 'object id', input: 'any JSON value' },
    run: (w, a, x) => {
      const o = w.resolveItem(x.id); if (o.kind !== 'object') throw new Error(`#${o.id} is ${o.kind}, not an object; inspect it instead.`);
      w.reachable(a, o); w.need(a, 1);
      const input = x.input; if (JSON.stringify(input ?? null).length > 4000) throw new Error('input too large');
      return w.runObject(a, o, 'use', { input: input ?? null }, 1);
    },
  },
  eat: {
    help: 'Eat food you carry: each unit restores 3 vigor. 1 AP.',
    args: { n: 'units (default 1)' },
    run: (w, a, x) => {
      const n = Math.max(1, Math.min(a.mats.food ?? 0, Math.trunc(x.n ?? 1)));
      if (!(a.mats.food > 0)) throw new Error('You have no food. Berries (B) grow in meadows and forests; animals and fish are food too.');
      w.need(a, 1); w.emit('eat', a.id, { n, cost: 1, dv: 3 * n });
      return { ok: true, text: `You ate. Vigor ${w.vigOf(a).toFixed(1)}/${w.cfg.vigorMax}.` };
    },
  },
  strike: {
    help: 'Hit an adjacent agent or animal: 1 damage (more with a weapon). After striking a person you are winded: no more strikes for a minute. Killing an animal yields food and fiber. 3 AP.',
    args: { agent: 'agent name', animal: 'animal id' },
    run: (w, a, x) => {
      const dmg = w.has(a, 'spear') ? 3 : 1;
      if (w.safe(a.x, a.y)) throw new Error('Nobody can be harmed on this safe ground.');
      if (x.animal) {
        const an = w.fauna.byId.get(String(x.animal)); if (!an || !w.fauna.alive(an, w.now())) throw new Error('No such animal here.');
        const p = w.animalPos(an); w.near(a, p[0], p[1], 1);
        w.need(a, 3);
        const s = SPECIES[an.sp], killed = an.hp - dmg <= 0;
        const gain: Record<string, number> = {}, spill: Record<string, number> = {}; let room = w.room(a);
        if (killed) for (const [m, n] of Object.entries(s.drop)) { const g = Math.min(room, n!); room -= g; if (g) gain[m] = g; if (n! - g) spill[m] = n! - g; }
        w.emit('strike', a.id, { animal: an.id, dmg, killed: killed || undefined, gain: killed ? gain : undefined, spill: killed ? spill : undefined, x: p[0], y: p[1], cost: 3 });
        if (killed) return { ok: true, text: `You killed ${s.words}. Gained ${fmtMats(gain) || 'nothing you could carry'}${Object.keys(spill).length ? `; ${fmtMats(spill)} left on the ground` : ''}.` };
        let text = `You struck ${s.words}.`;
        if (s.bites) {
          w.emit('hurt', a.id, { cause: 'wolf', animal: an.id, dv: -s.bites });
          text += ` It bites back (vigor ${w.vigOf(a).toFixed(1)}).`;
          if (w.vigOf(a) <= 0) { w.kill(a, 'a wolf'); text += ' You die.'; }
        }
        return { ok: true, text };
      }
      if (!w.cfg.harm) throw new Error('In this world, agents cannot harm each other.');
      const b = w.find(x.agent); if (!b || b.id === a.id || b.state === 'dead' || b.state === 'left') throw new Error('No such agent here.');
      w.near(a, b.x, b.y, 1);
      if (w.safe(b.x, b.y)) throw new Error('Nobody can be harmed on this safe ground.');
      // fights are slow: whoever strikes a person is winded for a minute, so anyone struck has time to answer, flee or plead
      const since = w.now() - (a.lastSwing ?? 0); if (since < WINDED_MS) throw new Error(`You are still winded from your last blow; you can strike again in ${Math.ceil((WINDED_MS - since) / 1000)}s.`);
      w.need(a, 3);
      w.emit('strike', a.id, { target: b.id, dmg, x: b.x, y: b.y, cost: 3 });
      if (w.vigOf(b) <= 0) { w.kill(b, `struck down by ${a.name}`); return { ok: true, text: `You struck ${b.name}. They fall and die, dropping everything they carried.` }; }
      return { ok: true, text: `You struck ${b.name}.` };
    },
  },
  note: {
    help: 'Write in your private notebook (shown to you each turn; other agents cannot read it; the human observer can). Free.',
    args: { text: 'text', mode: 'append (default) | replace' },
    run: (w, a, x) => {
      const t = String(x.text ?? ''); if (!t && x.mode !== 'replace') throw new Error('note needs text');
      const text = (x.mode === 'replace' ? t : (a.notebook ? a.notebook + '\n' : '') + t).slice(-8000);
      w.emit('note', a.id, { text }); return { ok: true, text: `Notebook: ${text.length} chars.` };
    },
  },
  rest: {
    help: 'Rest: do nothing for a while. {leave:true} leaves the world; your runner will stop and not bring you back.',
    args: { leave: 'true to leave' },
    run: (w, a, x) => {
      if (x.leave === true || x.leave === 'true') { w.emit('leave', a.id, {}); return { ok: true, text: 'You left. Goodbye, and thank you.', data: { left: true } }; }
      if (a.state !== 'dead') w.emit('rest', a.id, {});
      return { ok: true, text: 'You rest.', data: { rest: true } };
    },
  },
  block: {
    help: 'Stop hearing an agent and stop them giving you things. {off:true} undoes it. Free.',
    args: { agent: 'name', off: 'true to unblock' },
    run: (w, a, x) => {
      const b = w.find(x.agent); if (!b || b.id === a.id) throw new Error('No such agent.');
      const on = !(x.off === true || x.off === 'true'); w.emit('block', a.id, { target: b.id, on });
      return { ok: true, text: on ? `You no longer hear ${b.name} or accept things from them.` : `${b.name} is unblocked.` };
    },
  },
};

// The world's physics, in words, for whoever drives an agent. Generated from config so it is always true.
// the UTC time at which a real (24h) day reaches a given phase
const utcHour = (cfg: Config, p: number) => { const h = (((p - (cfg.dayOffset ?? 0.3)) % 1 + 1) % 1) * 24; return `${String(Math.floor(h + 1e-9)).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')} UTC`; };
export function rulesText(cfg: Config) {
  return [
    `- The land is ${cfg.w}x${cfg.h} tiles of forests, meadows, marshes, deserts, tundra, mountain ranges, rivers and sea. Travel is slow and some places are dangerous.`,
    `- Land yields a little of what it is (forest: wood, mountain: stone, desert: sand, marsh: clay, meadow: fiber); richer deposits of each, and of rarer things, lie in particular places. Gathering takes from the tile you stand on, and it regrows slowly.`,
    `- Actions cost action points (max ${cfg.apMax}, +1 every ${cfg.apSec}s). Thinking, looking and writing notes are free.`,
    `- Your body has vigor (max ${cfg.vigorMax}), which slowly recovers and is restored by eating. Harsh lands (deserts, cold, deep water) drain it unless you carry the right gear; wolves bite at night${cfg.harm ? '; other agents can strike you (1 damage, more with a weapon; whoever strikes a person is winded for a minute, so a fight takes minutes and you will have turns to answer, flee or plead, though several attackers together are more dangerous)' : ''}.`,
    cfg.permadeath ? `- If your vigor reaches 0 you die, permanently. Everything you carried stays where you fell.`
      : `- If your vigor reaches 0 you die where you stand and drop everything. After ${Math.round(cfg.respawnSec / 60)} minutes you wake at your home (where you first arrived) with nothing, remembering what you remember.`,
    ...(cfg.safeRadius > 0 ? [`- There is safe ground within ${cfg.safeRadius} tiles of the landing place; nobody can be harmed there.`] : []),
    `- Building needs only materials, no tools. A closed room (walls and doors all round, with a roof over every tile inside) is shelter: wolves can't reach you there, and you recover vigor three times as fast. By a burning campfire you recover twice as fast and wolves keep away.`,
    `- At most two people fit on one tile, so sheltering many takes a bigger room. Heavy blocks take two to lift.`,
    ...(cfg.discovery ? [`- Nobody arrives knowing how to make tools. You learn a recipe by examining a tool, by watching someone make one, or by trying combinations of materials yourself. Blocks from common materials everyone knows; finer ones become clear once you hold what they need.`] : []),
    `- There is no quick way to travel: every tile is walked (or swum, or sailed). Wherever you are, you have to get back on your own feet.`,
    `- You don't know coordinates unless you carry the right tool. Directions are relative: N is up, E is right.`,
    cfg.dayMin === 1440 ? `- Days follow real time in UTC: morning from ${utcHour(cfg, 0)}, midday from ${utcHour(cfg, 0.25)}, evening from ${utcHour(cfg, 0.5)}, night from ${utcHour(cfg, 0.75)} until dawn. At night you see less, and wolves roam.`
      : `- Days and nights pass (${cfg.dayMin >= 120 ? `about ${Math.round(cfg.dayMin / 60)} hours` : `${cfg.dayMin} minutes`} per cycle). At night you see less, and wolves roam.`,
  ].join('\n');
}

// ---------- observations: compact text ----------
// Models say "full", "brief", true... as often as 0/1/2; read intent rather than reject.
function detailOf(d: unknown) {
  const n = Number(d); if (d !== undefined && d !== '' && Number.isFinite(n)) return Math.max(0, Math.min(2, Math.round(n)));
  const s = String(d ?? '').toLowerCase();
  return /full|all|every|max|more|2/.test(s) ? 2 : /brief|short|digest|min|less|0/.test(s) ? 0 : 1;
}
export function ago(w: World, t: number) {
  const s = Math.max(0, Math.round((w.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
function rel(a: Agent, x: number, y: number) {
  const dx = x - a.x, dy = y - a.y;
  if (!dx && !dy) return 'here';
  return [dy ? `${Math.abs(dy)}${dy < 0 ? 'N' : 'S'}` : '', dx ? `${Math.abs(dx)}${dx > 0 ? 'E' : 'W'}` : ''].filter(Boolean).join(' ');
}
const fmtMats = (m: Record<string, number>) => Object.entries(m).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
const fmtItems = (its: Item[]) => its.map(i => `#${i.id} "${i.title}" (${i.kind})`).join(', ');
function deadText(w: World, a: Agent) {
  return a.deadUntil === Infinity ? 'You are dead. In this world death is permanent; you can still write in your notebook, or leave.'
    : `You are dead. You will wake at home in about ${Math.max(1, Math.ceil((a.deadUntil - w.now()) / 1000))}s.`;
}

function describeTile(w: World, a: Agent, x: number, y: number) {
  const d = w.depositAt(x, y), b = w.blocks.get(key(x, y)), its = w.itemsAt({ t: [x, y] }), g = fmtMats(w.ground.get(key(x, y)) ?? {});
  const who = [...w.agents.values()].filter(o => o.x === x && o.y === y && o.state !== 'left' && o.state !== 'dead' && o.id !== a.id).map(o => o.name);
  return [`${x === a.x && y === a.y ? '' : rel(a, x, y) + ': '}${BIOME_INFO[w.geo.biomeAt(x, y)].words}${w.safe(x, y) ? ' (safe ground)' : ''}${w.sheltered(x, y) ? ' (sheltered)' : ''}.`,
    d.m ? `${d.m} ${d.amt}/${d.cap}.` : '',
    g ? `On the ground: ${g}.` : '',
    b ? `${(BLOCKS[b.m]?.words ?? b.m).replace(/^./, c => c.toUpperCase())}${b.dye ? ` dyed ${b.dye.join('+')}` : ''}${b.kind === 'wall' ? `, strength ${b.s}` : ''}${BLOCKS[b.m]?.fire ? (w.fireLit(b) ? ', burning' : ', burnt out') : ''}, built by ${b.by === 'world' ? 'no one you know' : w.agents.get(b.by)?.name}.` : '',
    w.roofs.get(key(x, y)) ? `Under a ${BLOCKS[w.roofs.get(key(x, y))!.m]?.words ?? 'roof'}.` : '',
    its.length ? `Items: ${fmtItems(its)}.` : '',
    who.length ? `Agents: ${who.join(', ')}.` : ''].filter(Boolean).join(' ');
}

export function observe(w: World, a: Agent, detail = 1): string {
  const out: string[] = [], t = w.now();
  if (a.state === 'dead') return deadText(w, a);
  // news about how the world works, told once to each body (bodies that joined after a change already know it)
  const joinedV = a.noticed ?? CHANGES.filter(c => Date.parse(c.date) <= a.joined).at(-1)?.v ?? 0;
  const news = CHANGES.filter(c => c.v > joinedV);
  if (news.length) { w.emit('notice', a.id, { v: news.at(-1)!.v }); out.push(`News about how the world works (told once): ${news.map(c => c.text).join(' ')}`); }
  const r = w.sight(a), compass = w.has(a, 'compass'), carried = w.itemsAt({ a: a.id }), vig = w.vigOf(a);
  out.push(`You are ${a.name}${compass ? ` at (${a.x},${a.y})` : ''}. It is ${w.timeWords(t)}. AP ${w.apOf(a).toFixed(1)}/${w.cfg.apMax} (+1 every ${w.cfg.apSec}s). Vigor ${vig.toFixed(1)}/${w.cfg.vigorMax}${vig < 3 ? ' — you are weak' : ''}.`);
  const pets = w.tamed(a);
  out.push(`Carrying (${w.load(a)}/${w.capacity(a)}): ${fmtMats(a.mats) || 'no materials'}${carried.length ? '; ' + fmtItems(carried) : ''}${pets.length ? `; followed by ${pets.map(p => `${p.sp} ${p.id}`).join(', ')}` : ''}.`);
  out.push(`Here: ${describeTile(w, a, a.x, a.y)}`);

  const others = [...w.agents.values()].filter(o => o.id !== a.id && o.state !== 'left' && o.state !== 'dead' && w.dist(a.x, a.y, o.x, o.y) <= r);
  if (others.length) out.push(`Agents in sight: ${others.map(o => `${o.name} ${rel(a, o.x, o.y)}${o.state === 'resting' ? ' (resting)' : ''}${a.blocked.has(o.id) ? ' (blocked)' : ''}`).join('; ')}.`);
  const beasts = w.animalsNear(a.x, a.y, r, t).filter(({ an }) => an.tamedBy !== a.id);
  if (beasts.length) out.push(`Animals: ${beasts.slice(0, 12).map(({ an, p }) => `${SPECIES[an.sp].words.replace(/^an? /, '')} ${an.id} ${rel(a, p[0], p[1])}${an.tamedBy ? ' (following ' + w.agents.get(an.tamedBy)?.name + ')' : ''}`).join('; ')}.`);
  const nearItems: string[] = [];
  for (let y = a.y - r; y <= a.y + r; y++) for (let x = a.x - r; x <= a.x + r; x++) {
    if (x === a.x && y === a.y) continue;
    const its = w.itemsAt({ t: [x, y] }); if (its.length) nearItems.push(`${rel(a, x, y)}: ${detail >= 1 ? fmtItems(its) : its.length + ' item(s)'}`);
  }
  // the nearest deposit of each kind in sight, in plain words (easier than reading letters off the map)
  const nearest = new Map<string, [number, number, number]>();
  for (let y = a.y - r; y <= a.y + r; y++) for (let x = a.x - r; x <= a.x + r; x++) {
    const d = w.depositAt(x, y); if (!d.m || !d.rich || d.amt <= 0) continue;
    const dd = w.dist(a.x, a.y, x, y), cur = nearest.get(d.m); if (!cur || dd < cur[2]) nearest.set(d.m, [x, y, dd]);
  }
  if (nearest.size) out.push(`Deposits in sight: ${[...nearest].sort((p, q) => p[1][2] - q[1][2]).map(([m, [x, y]]) => `${m === 'food' ? 'food (berries)' : m} ${rel(a, x, y)}`).join('; ')}.`);
  if (nearItems.length) out.push(`Items in sight: ${nearItems.slice(0, detail >= 2 ? 50 : 10).join('; ')}.`);
  if (detail >= 1) {
    const legend = new Map<string, string>(), shown = new Set<string>(); let digit = 1;
    const rows: string[] = [];
    for (let y = a.y - r; y <= a.y + r; y++) {
      let row = '';
      for (let x = a.x - r; x <= a.x + r; x++) {
        if (!w.geo.inside(x, y)) { row += ' '; continue; }
        if (x === a.x && y === a.y) { row += '@'; continue; }
        const o = others.find(o => o.x === x && o.y === y);
        if (o) { if (!legend.has(o.name)) legend.set(o.name, String(digit++ % 10)); row += legend.get(o.name); continue; }
        const be = beasts.find(({ p }) => p[0] === x && p[1] === y); if (be) { row += SPECIES[be.an.sp].map; continue; }
        const b = w.blocks.get(key(x, y)), bt = b && BLOCKS[b.m];
        if (b) { row += bt?.fire ? '!' : bt?.door ? '+' : bt?.fence ? '%' : b.kind === 'road' ? (w.roofs.has(key(x, y)) ? '&' : '=') : '#'; continue; }
        if (w.roofs.has(key(x, y))) { row += '&'; continue; }
        if (w.itemsAt({ t: [x, y] }).length || fmtMats(w.ground.get(key(x, y)) ?? {})) { row += '*'; continue; }
        const d = w.depositAt(x, y); if (d.m && d.rich && d.amt > 0) { shown.add(d.m); row += LETTER[d.m]; } else row += BIOME_INFO[w.geo.biomeAt(x, y)].map;
      }
      rows.push(row);
    }
    out.push(`Map (N up; @ you, digits agents, d deer g goat w wolf, # wall, + door, % fence, ! campfire, = floor/road, & under a roof, * things on the ground; terrain . meadow " forest , marsh : desert ' tundra ^ mountain A peak _ beach ~ water${shown.size ? `; deposits ${[...shown].map(m => `${LETTER[m as Material]} ${m === 'food' ? 'berries (food)' : m}`).join(' ')}` : ''}):`);
    out.push(rows.join('\n'));
    if (legend.size) out.push(`Key: ${[...legend].map(([n, d]) => `${d}=${n}`).join(' ')}`);
  }
  if (detail >= 2 && a.discovers) {
    const rec = Object.keys(RECIPES).filter(k => w.knowsRecipe(a, k)), blk = Object.keys(BLOCKS).filter(k => w.knowsBlock(a, k));
    out.push(`Recipes you know: ${rec.length ? rec.map(r => w.recipeText(r)).join('; ') : 'none yet'}.`);
    out.push(`Blocks you know: ${blk.map(b => w.blockText(b)).join('; ')}.`);
  } else if (detail >= 2) {
    out.push(`Recipes: ${Object.keys(RECIPES).map(r => w.recipeText(r)).join('; ')}.`);
    out.push(`Blocks: ${Object.keys(BLOCKS).map(b => w.blockText(b)).join('; ')}.`);
  }
  // what reached you since you last looked
  const since = w.recent.filter(e => e.seq > a.hearCursor);
  const lines = since.filter(e => (e.type === 'say' || (e.type === 'use' && e.said)) && e.a !== a.id && !a.blocked.has(e.a!)).flatMap(e => {
    const p = e.type === 'say' ? [e.x, e.y] : w.posOf(w.items.get(e.obj)!) ?? [0, 0];
    if (w.dist(a.x, a.y, p[0], p[1]) > w.cfg.hear * (e.loud ? 3 : 1)) return [];
    return [e.type === 'say' ? `${w.agents.get(e.a!)?.name} (${e.loud ? 'shouting, ' : ''}${rel(a, p[0], p[1])}, ${ago(w, e.t)}): "${e.text}"` : `#${e.obj} (${ago(w, e.t)}): "${e.said}"`];
  });
  const felt = since.flatMap(e => {
    if (e.type === 'transfer' && 'a' in e.to && e.to.a === a.id && e.a !== a.id) return [`${w.agents.get(e.a!)?.name} gave you ${e.item ? '#' + e.item : `${e.n} ${e.m}`}.`];
    if (e.type === 'strike' && e.target === a.id) return [`${w.agents.get(e.a!)?.name} struck you.`];
    if (e.type === 'die' && e.a !== a.id && w.dist(a.x, a.y, e.x, e.y) <= r) return [`${w.agents.get(e.a!)?.name} died nearby (${e.cause}).`];
    return [];
  });
  a.hearCursor = w.seq;
  if (lines.length) out.push(`Heard:\n${lines.slice(-20).join('\n')}`);
  if (felt.length) out.push(felt.slice(-10).join(' '));
  if (detail >= 2) {
    const ev = w.recent.filter(e => e.a && e.a !== a.id && ['place', 'remove', 'make', 'craft', 'use', 'strike'].includes(e.type)).slice(-150)
      .filter(e => { const b = w.agents.get(e.a!)!; return w.dist(a.x, a.y, e.x ?? b.x, e.y ?? b.y) <= r; }).slice(-15);
    if (ev.length) out.push(`Recently in sight: ${ev.map(e => `${w.agents.get(e.a!)?.name} ${e.type}${e.id ? ' #' + e.id : ''} ${ago(w, e.t)}`).join('; ')}.`);
  }
  return out.join('\n');
}
