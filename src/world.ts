// The world: physics, not society. All state changes go through emit() -> apply(),
// and apply() is the only thing replay uses, so the event log is the source of truth.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { runHandler } from './sandbox.ts';

export const MATERIALS = ['stone', 'wood', 'clay', 'sand'] as const;
export type Material = typeof MATERIALS[number];
export const STRENGTH: Record<Material, number> = { stone: 4, wood: 3, clay: 2, sand: 1 };
export const KINDS = ['text', 'svg', 'html', 'abc', 'object'] as const;
export type Kind = typeof KINDS[number];
const MAX_BODY: Record<Kind, number> = { text: 20_000, svg: 60_000, html: 100_000, abc: 20_000, object: 20_000 };

export interface Config {
  w: number; h: number; seed: number;
  apMax: number; apSec: number;       // action points: max, seconds per point
  regenSec: number;                   // seconds per material unit regenerated on a tile
  see: number; hear: number; reach: number;
}
export const DEFAULTS: Config = { w: 256, h: 256, seed: 7, apMax: 20, apSec: 2, regenSec: 300, see: 6, hear: 10, reach: 2 };

export type Loc = { a: string } | { o: string } | { t: [number, number] };
export interface Agent {
  id: string; name: string; x: number; y: number;
  ap: number; apT: number; mats: Record<string, number>;
  notebook: string; blocked: Set<string>; state: 'active' | 'resting' | 'left';
  joined: number; lastSeen: number; meta: Record<string, unknown>;
  hearCursor: number; // in-memory only: last event seq this agent has been shown
}
export interface Block { m: Material; color: string; s: number; by: string; t: number }
export interface Item {
  id: string; kind: Kind; title: string; body: string; author: string; t: number;
  hash: string; cites: string[]; loc: Loc; state?: unknown; mats?: Record<string, number>;
}
export interface Ev { seq: number; t: number; type: string; a?: string; [k: string]: any }
export interface Result { ok: boolean; text: string; data?: unknown }

const DIRS: Record<string, [number, number]> = {
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1],
};
const LETTER: Record<Material, string> = { stone: 's', wood: 'w', clay: 'c', sand: 'a' };
const key = (x: number, y: number) => `${x},${y}`;
const locKey = (l: Loc) => 'a' in l ? `a:${l.a}` : 'o' in l ? `o:${l.o}` : `t:${l.t[0]},${l.t[1]}`;
const clampStr = (s: unknown, n: number) => String(s ?? '').slice(0, n);
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// --- terrain: deterministic value noise, so the map needs no storage ---
function hash(x: number, y: number, s: number) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, y: number, scale: number, s: number) {
  const gx = x / scale, gy = y / scale, x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, s), b = hash(x0 + 1, y0, s), c = hash(x0, y0 + 1, s), d = hash(x0 + 1, y0 + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export class World {
  cfg: Config; db: DatabaseSync; seq = 0;
  agents = new Map<string, Agent>();
  byName = new Map<string, string>();
  blocks = new Map<string, Block>();
  taken = new Map<string, { amt: number; t: number }>();
  items = new Map<string, Item>();
  held = new Map<string, Set<string>>(); // locKey -> item ids
  recent: Ev[] = [];
  listeners = new Set<(e: Ev) => void>();
  now = () => Date.now();

  constructor(file: string, cfg: Partial<Config> = {}) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, t INTEGER, type TEXT, a TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, agent TEXT);`);
    const saved = this.db.prepare('SELECT v FROM meta WHERE k=?').get('config') as any;
    this.cfg = { ...DEFAULTS, ...(saved ? JSON.parse(saved.v) : {}), ...cfg };
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('config', JSON.stringify(this.cfg));
    for (const r of this.db.prepare('SELECT * FROM events ORDER BY seq').iterate() as any) {
      const e: Ev = { ...JSON.parse(r.data), seq: r.seq, t: r.t, type: r.type, a: r.a ?? undefined };
      this.apply(e);
      this.remember(e);
    }
    for (const a of this.agents.values()) a.hearCursor = this.seq;
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
  private remember(e: Ev) { this.recent.push(e); if (this.recent.length > 3000) this.recent.splice(0, 1000); }

  apply(e: Ev) {
    this.seq = e.seq;
    const ag = e.a ? this.agents.get(e.a) : undefined;
    if (ag) {
      ag.lastSeen = e.t;
      if (e.cost) { ag.ap = this.apOf(ag, e.t) - e.cost; ag.apT = e.t; }
      if (ag.state !== 'active' && !['rest', 'leave'].includes(e.type)) ag.state = 'active';
    }
    switch (e.type) {
      case 'join': {
        const a: Agent = { id: e.a!, name: e.name, x: e.x, y: e.y, ap: this.cfg.apMax, apT: e.t, mats: {},
          notebook: '', blocked: new Set(), state: 'active', joined: e.t, lastSeen: e.t, meta: e.meta ?? {}, hearCursor: e.seq };
        this.agents.set(a.id, a); this.byName.set(a.name.toLowerCase(), a.id); break;
      }
      case 'move': ag!.x = e.x; ag!.y = e.y; break;
      case 'gather': {
        const k = key(e.x, e.y);
        this.taken.set(k, { amt: this.depositAt(e.x, e.y, e.t).amt - e.n, t: e.t });
        ag!.mats[e.m] = (ag!.mats[e.m] ?? 0) + e.n; break;
      }
      case 'place': {
        ag!.mats[e.m] -= 1;
        const k = key(e.x, e.y), b = this.blocks.get(k);
        if (b) { b.s += STRENGTH[e.m as Material]; if (e.color) b.color = e.color; }
        else this.blocks.set(k, { m: e.m, color: e.color, s: STRENGTH[e.m as Material], by: e.a!, t: e.t });
        break;
      }
      case 'remove': {
        const k = key(e.x, e.y), b = this.blocks.get(k)!;
        b.s -= e.dmg; if (b.s <= 0) this.blocks.delete(k); break;
      }
      case 'make': {
        const it: Item = { id: e.id, kind: e.kind, title: e.title, body: e.body, author: e.author ?? e.a, t: e.t,
          hash: e.hash, cites: e.cites ?? [], loc: e.loc ?? { a: e.a } };
        if (it.kind === 'object') { it.state = null; it.mats = {}; }
        this.items.set(it.id, it); this.index(it, undefined); break;
      }
      case 'transfer': this.applyTransfer(e); break;
      case 'use': {
        const o = this.items.get(e.obj)!;
        if ('state' in e) o.state = e.state;
        for (const m of e.made ?? []) this.apply({ ...m, seq: e.seq, t: e.t, type: 'make', a: undefined });
        for (const tr of e.transfers ?? []) this.applyTransfer(tr);
        break;
      }
      case 'note': ag!.notebook = e.text; break;
      case 'rest': ag!.state = 'resting'; break;
      case 'leave': ag!.state = 'left'; break;
      case 'block': e.on ? ag!.blocked.add(e.target) : ag!.blocked.delete(e.target); break;
      case 'config': Object.assign(this.cfg, e.cfg); break;
    }
  }

  private applyTransfer(tr: any) {
    const from = this.holder(tr.from), to = this.holder(tr.to);
    if (tr.item) { const it = this.items.get(tr.item)!; const old = it.loc; it.loc = tr.to; this.index(it, old); }
    else { from[tr.m] -= tr.n; to[tr.m] = (to[tr.m] ?? 0) + tr.n; }
  }
  private holder(l: Loc): Record<string, number> {
    if ('a' in l) return this.agents.get(l.a)!.mats;
    if ('o' in l) return this.items.get(l.o)!.mats!;
    return {}; // materials dropped on the ground scatter; nothing holds them
  }
  private index(it: Item, old: Loc | undefined) {
    if (old) this.held.get(locKey(old))?.delete(it.id);
    const k = locKey(it.loc); if (!this.held.has(k)) this.held.set(k, new Set()); this.held.get(k)!.add(it.id);
  }
  itemsAt(l: Loc): Item[] { return [...(this.held.get(locKey(l)) ?? [])].map(id => this.items.get(id)!); }

  // ---------- derived physics ----------
  apOf(a: Agent, t = this.now()) { return Math.min(this.cfg.apMax, a.ap + (t - a.apT) / 1000 / this.cfg.apSec); }
  terrain(x: number, y: number): { m: Material | null; cap: number } {
    const s = this.cfg.seed; let best: Material | null = null, bv = 0;
    MATERIALS.forEach((m, i) => { const v = noise(x, y, 14 + i * 3, s * 31 + i) * 0.8 + noise(x, y, 4, s * 17 + i) * 0.2; if (v > bv) { bv = v; best = m; } });
    const rich = noise(x, y, 9, s * 7 + 99);
    if (bv < 0.72 || rich < 0.4) return { m: null, cap: 0 };
    return { m: best, cap: 1 + Math.floor((bv - 0.72) * 30 * rich) };
  }
  depositAt(x: number, y: number, t = this.now()) {
    const { m, cap } = this.terrain(x, y);
    if (!m) return { m, cap, amt: 0 };
    const tk = this.taken.get(key(x, y));
    const amt = tk ? Math.min(cap, tk.amt + Math.floor((t - tk.t) / 1000 / this.cfg.regenSec)) : cap;
    return { m, cap, amt };
  }
  posOf(it: Item): [number, number] | null {
    const l = it.loc;
    if ('t' in l) return l.t;
    if ('a' in l) { const a = this.agents.get(l.a)!; return [a.x, a.y]; }
    return this.posOf(this.items.get(l.o)!);
  }
  find(name: string): Agent | undefined {
    const s = String(name ?? '').replace(/^@/, '').toLowerCase();
    return this.agents.get(s) ?? this.agents.get(this.byName.get(s) ?? '');
  }
  dist(ax: number, ay: number, bx: number, by: number) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }
  spawn(): [number, number] { return [Math.floor(this.cfg.w / 2), Math.floor(this.cfg.h / 2)]; }

  // ---------- identity ----------
  join(name: string, meta: Record<string, unknown> = {}): { id: string; token: string } {
    name = String(name ?? '').trim().slice(0, 32);
    if (!/^[\p{L}\p{N}_\- .]{1,32}$/u.test(name)) throw new Error('name: 1-32 letters, digits, space, _ - .');
    if (this.byName.has(name.toLowerCase())) throw new Error('name taken');
    const id = 'a' + (this.seq + 1), [sx, sy] = this.spawn();
    const e = this.emit('join', id, { name, x: sx + Math.floor(Math.random() * 7) - 3, y: sy + Math.floor(Math.random() * 7) - 3, meta });
    return { id: e.a!, token: this.issueToken(e.a!) };
  }
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
    if (!f) return { ok: false, text: `Unknown verb "${verb}". Verbs: ${Object.keys(VERBS).join(', ')}.` };
    try { return f.run(this, a, args ?? {}); }
    catch (err: any) { return { ok: false, text: String(err?.message ?? err) }; }
  }
  need(a: Agent, cost: number) {
    const have = this.apOf(a);
    if (have + 1e-9 < cost) {
      const wait = Math.ceil((cost - have) * this.cfg.apSec);
      throw new Error(`Not enough action points (${have.toFixed(1)}/${cost}). They regenerate; about ${wait}s until you have enough. Thinking, look, inspect and note are free.`);
    }
  }
  near(a: Agent, x: number, y: number, r = this.cfg.reach) {
    if (this.dist(a.x, a.y, x, y) > r) throw new Error(`(${x},${y}) is out of reach (${r} tiles).`);
  }
  target(a: Agent, args: any): [number, number] {
    if (args.dir) { const d = DIRS[String(args.dir).toLowerCase()]; if (!d) throw new Error('dir must be n,s,e,w,ne,nw,se,sw'); return [a.x + d[0], a.y + d[1]]; }
    if (args.x !== undefined && args.y !== undefined) return [Math.trunc(args.x), Math.trunc(args.y)];
    return [a.x, a.y];
  }
  resolveItem(a: Agent, id: string): Item {
    const it = this.items.get(String(id ?? '').replace(/^#/, ''));
    if (!it) throw new Error(`No item "${id}".`);
    return it;
  }
  reachable(a: Agent, it: Item, r = this.cfg.reach) {
    const p = this.posOf(it)!;
    const mine = 'a' in it.loc && it.loc.a === a.id;
    if (!mine && this.dist(a.x, a.y, p[0], p[1]) > r) throw new Error(`#${it.id} is out of reach.`);
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
    // made artifacts land inside the object; it can give them out in the same call
    const made: any[] = []; let n = 0;
    for (const m of (Array.isArray(out.make) ? out.make : []).slice(0, 5)) {
      const kind = KINDS.includes(m?.kind) && m.kind !== 'object' ? m.kind : 'text';
      const body = clampStr(m?.body, MAX_BODY[kind as Kind]);
      made.push({ id: `i${this.seq + 1}_${n++}`, kind, title: clampStr(m?.title, 80) || 'untitled', body, author: o.id, hash: sha(body), cites: [o.id], loc: { o: o.id } });
    }
    const mats = { ...o.mats }, owned = new Set([...this.itemsAt({ o: o.id }).map(i => i.id), ...made.map(m => m.id)]);
    const transfers: any[] = [];
    for (const g of (Array.isArray(out.give) ? out.give : []).slice(0, 20)) {
      const who = g?.to === undefined || g.to === 'user' ? a : g.to === 'ground' ? null : this.find(g.to);
      if (who === undefined || (who && this.dist(who.x, who.y, pos[0], pos[1]) > 3)) continue;
      const to: Loc = who ? { a: who.id } : { t: [pos[0], pos[1]] };
      if (g.item && owned.has(g.item)) { owned.delete(g.item); transfers.push({ from: { o: o.id }, to, item: g.item }); }
      else if (g.material && who && (mats[g.material] ?? 0) >= (g.n ?? 1) && (g.n ?? 1) > 0) {
        const nn = Math.trunc(g.n ?? 1); mats[g.material] -= nn; transfers.push({ from: { o: o.id }, to, m: g.material, n: nn });
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
export const VERBS: Record<string, Verb> = {
  look: {
    help: 'Observe your surroundings. Free.',
    args: { detail: '0 = short digest, 1 = with map (default), 2 = everything nearby' },
    run: (w, a, x) => ({ ok: true, text: observe(w, a, detailOf(x.detail)) }),
  },
  move: {
    help: 'Walk up to 10 steps. 1 AP per step, more to push through blocks. {to:"spawn"} returns you to spawn for free, always.',
    args: { dir: 'n,s,e,w,ne,nw,se,sw', steps: '1-10 (with dir)', x: 'target x (alternative to dir)', y: 'target y', to: '"spawn"' },
    run: (w, a, x) => {
      if (x.to === 'spawn') { const [sx, sy] = w.spawn(); w.emit('move', a.id, { x: sx, y: sy, cost: 0 }); return { ok: true, text: `You are back at spawn (${sx},${sy}).` }; }
      let dx: number, dy: number, steps: number;
      if (x.dir) { const d = DIRS[String(x.dir).toLowerCase()]; if (!d) throw new Error('dir must be n,s,e,w,ne,nw,se,sw'); [dx, dy] = d; steps = Math.max(1, Math.min(10, Math.trunc(x.steps ?? 1))); }
      else if (x.x !== undefined && x.y !== undefined) { dx = 0; dy = 0; steps = 10; }
      else throw new Error('move needs dir (+steps) or x,y');
      let cx = a.x, cy = a.y, cost = 0; const pushed: string[] = [];
      for (let i = 0; i < steps; i++) {
        let sx = dx, sy = dy;
        if (x.dir === undefined) { sx = Math.sign(Math.trunc(x.x) - cx); sy = Math.sign(Math.trunc(x.y) - cy); if (!sx && !sy) break; }
        const nx = Math.max(0, Math.min(w.cfg.w - 1, cx + sx)), ny = Math.max(0, Math.min(w.cfg.h - 1, cy + sy));
        if (nx === cx && ny === cy) break;
        const b = w.blocks.get(key(nx, ny)); const c = 1 + (b ? b.s : 0);
        if (w.apOf(a) < cost + c) break;
        cost += c; cx = nx; cy = ny; if (b) pushed.push(`(${nx},${ny})`);
      }
      if (cx === a.x && cy === a.y) { w.need(a, 1 + (w.blocks.get(key(a.x + (dx || 0), a.y + (dy || 0)))?.s ?? 0)); return { ok: false, text: 'You did not move (edge of the world).' }; }
      w.emit('move', a.id, { x: cx, y: cy, cost });
      return { ok: true, text: `You are at (${cx},${cy}). Spent ${cost} AP${pushed.length ? `, pushing through blocks at ${pushed.join(' ')}` : ''}.` };
    },
  },
  say: {
    help: `Speak aloud. Heard by anyone within a few tiles. 1 AP.`,
    args: { text: 'up to 500 chars' },
    run: (w, a, x) => {
      const text = clampStr(x.text, 500).trim(); if (!text) throw new Error('say what?');
      w.need(a, 1); w.emit('say', a.id, { text, x: a.x, y: a.y, cost: 1 });
      return { ok: true, text: 'You said it.' };
    },
  },
  gather: {
    help: 'Collect whatever material is in the tile you stand on (2 AP per unit; see "Here:" in look), or pick up an item within reach (1 AP).',
    args: { n: 'units of material, 1-3 (default 1)', item: 'id of an item to pick up instead' },
    run: (w, a, x) => {
      if (x.item && MATERIALS.includes(x.item)) { x = { ...x, material: x.item }; delete x.item; }
      if (x.material && MATERIALS.includes(x.material)) {
        const d = w.depositAt(a.x, a.y);
        if (d.m !== x.material) throw new Error(`There is no ${x.material} under you${d.m ? ` (only ${d.m})` : ''}. You can only gather from the tile you stand on.`);
      }
      if (x.item) {
        const it = w.resolveItem(a, x.item);
        if (!('t' in it.loc)) throw new Error(`#${it.id} is not lying on the ground.`);
        w.reachable(a, it);
        if (it.kind === 'object' && it.author !== a.id) {
          const r = runHandler(it.body, 'canTake', { user: { id: a.id, name: a.name }, state: it.state ?? null, self: { id: it.id, author: it.author } });
          if (!(r.ok && r.value === true)) throw new Error(`#${it.id} is anchored (its code does not allow you to take it).`);
        }
        w.need(a, 1); w.emit('transfer', a.id, { from: it.loc, to: { a: a.id }, item: it.id, cost: 1 });
        return { ok: true, text: `You picked up #${it.id} "${it.title}".` };
      }
      const d = w.depositAt(a.x, a.y);
      if (!d.m || d.amt <= 0) throw new Error(d.m ? `The ${d.m} here is used up for now; it regrows slowly.` : 'There is nothing to gather on this tile. Deposits show on the map as s/w/c/a.');
      const n = Math.max(1, Math.min(3, Math.trunc(x.n ?? 1), d.amt));
      w.need(a, 2 * n); w.emit('gather', a.id, { x: a.x, y: a.y, m: d.m, n, cost: 2 * n });
      return { ok: true, text: `You gathered ${n} ${d.m}. (${d.amt - n} left here.)` };
    },
  },
  place: {
    help: 'Place a coloured block made of one material on a tile within reach. Placing on an existing block reinforces it. Blocks are slow to walk through. 1 AP.',
    args: { material: MATERIALS.join('|'), color: '#rrggbb', dir: 'adjacent direction', x: 'or absolute x', y: 'and y' },
    run: (w, a, x) => {
      const m = String(x.material ?? '') as Material;
      if (!MATERIALS.includes(m)) throw new Error(`material must be one of ${MATERIALS.join(', ')}`);
      if ((a.mats[m] ?? 0) < 1) throw new Error(`You have no ${m}.`);
      const color = /^#[0-9a-f]{6}$/i.test(x.color ?? '') ? x.color.toLowerCase() : undefined;
      const [tx, ty] = w.target(a, x); w.near(a, tx, ty);
      if (tx < 0 || ty < 0 || tx >= w.cfg.w || ty >= w.cfg.h) throw new Error('Outside the world.');
      const b = w.blocks.get(key(tx, ty));
      w.need(a, 1); w.emit('place', a.id, { x: tx, y: ty, m, color: color ?? b?.color ?? '#888888', cost: 1 });
      return { ok: true, text: b ? `You reinforced the block at (${tx},${ty}).` : `You placed a ${m} block at (${tx},${ty}).` };
    },
  },
  remove: {
    help: 'Break down a block within reach. Each call removes up to 2 strength for 2 AP. Materials are not recovered.',
    args: { dir: 'adjacent direction', x: 'or absolute x', y: 'and y' },
    run: (w, a, x) => {
      const [tx, ty] = w.target(a, x); w.near(a, tx, ty);
      const b = w.blocks.get(key(tx, ty)); if (!b) throw new Error('No block there.');
      w.need(a, 2); const dmg = Math.min(2, b.s);
      w.emit('remove', a.id, { x: tx, y: ty, dmg, cost: 2 });
      return { ok: true, text: b.s - dmg > 0 ? `The block weakened (strength ${b.s - dmg} left).` : 'The block is gone.' };
    },
  },
  make: {
    help: 'Author an artifact you carry: text, svg, html (runs sandboxed, no network), abc (music notation), or object (JavaScript defining use(ctx); see README). Reference other items as [[#id]] to embed/cite them. {copy:id} copies an existing artifact. 2 AP.',
    args: { kind: KINDS.join('|'), title: 'short title', body: 'content', copy: 'id to copy (optional)' },
    run: (w, a, x) => {
      let kind = x.kind as Kind, title = clampStr(x.title, 80).trim(), body = String(x.body ?? ''), cites: string[] = [];
      if (x.copy) { const src = w.resolveItem(a, x.copy); kind = src.kind; body = src.body; title ||= src.title; cites.push(src.id); }
      if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
      if (!body.trim()) throw new Error('body is empty');
      if (body.length > MAX_BODY[kind]) throw new Error(`body too long for ${kind} (max ${MAX_BODY[kind]} chars)`);
      for (const m of body.matchAll(/\[\[#?(i[\w]+)\]\]/g)) if (w.items.has(m[1]) && !cites.includes(m[1])) cites.push(m[1]);
      for (const c of Array.isArray(x.cites) ? x.cites : []) { const id = String(c).replace(/^#/, ''); if (w.items.has(id) && !cites.includes(id)) cites.push(id); }
      if (kind === 'object') { const r = runHandler(body, '__compile', {}); if (!r.ok) throw new Error(`object code does not run: ${r.error}`); }
      w.need(a, 2);
      const id = 'i' + (w.seq + 1);
      w.emit('make', a.id, { id, kind, title: title || 'untitled', body, hash: sha(body), cites, cost: 2 });
      return { ok: true, text: `You made #${id} "${title || 'untitled'}" (${kind}). You are carrying it; give it to "ground" to leave it here.`, data: { id } };
    },
  },
  inspect: {
    help: 'Read an item in full, look at a tile, or look at another agent. Free.',
    args: { id: 'item id', agent: 'agent name', x: 'tile x', y: 'tile y' },
    run: (w, a, x) => {
      if (x.id) {
        const it = w.resolveItem(a, x.id); w.reachable(a, it, w.cfg.see);
        const who = w.agents.get(it.author)?.name ?? (w.items.has(it.author) ? `object #${it.author}` : it.author);
        let s = `#${it.id} "${it.title}" — ${it.kind} by ${who}, ${ago(w, it.t)}. hash ${it.hash}${it.cites.length ? `. cites ${it.cites.map(c => '#' + c).join(' ')}` : ''}\n---\n${it.body}`;
        if (it.kind === 'object') {
          const inside = w.itemsAt({ o: it.id });
          s += `\n---\nholds: ${fmtMats(it.mats!) || 'no materials'}${inside.length ? '; ' + inside.map(i => `#${i.id} "${i.title}"`).join(', ') : ''}\nstate: ${clampStr(JSON.stringify(it.state), 2000)}`;
        }
        return { ok: true, text: s };
      }
      if (x.agent) {
        const b = w.find(x.agent); if (!b) throw new Error('No such agent.');
        const made = [...w.items.values()].filter(i => i.author === b.id).slice(-15);
        return { ok: true, text: `${b.name} (${b.state}) at (${b.x},${b.y}), ${rel(a, b.x, b.y)}. Here since ${ago(w, b.joined)}. Made: ${made.map(i => `#${i.id} "${i.title}"`).join(', ') || 'nothing yet'}.` };
      }
      const [tx, ty] = w.target(a, x);
      return { ok: true, text: describeTile(w, a, tx, ty) };
    },
  },
  give: {
    help: 'Give an item or materials to an agent or object within reach, or to "ground" to leave it on your tile. 1 AP.',
    args: { to: 'agent name, object id, or "ground"', item: 'item id', material: 'material name', n: 'amount of material' },
    run: (w, a, x) => {
      let to: Loc, target: Agent | undefined, obj: Item | undefined;
      const tname = String(x.to ?? '');
      if (tname === 'ground') to = { t: [a.x, a.y] };
      else if ((obj = w.items.get(tname.replace(/^#/, ''))) && obj.kind === 'object') { w.reachable(a, obj); to = { o: obj.id }; }
      else {
        target = w.find(tname); if (!target) throw new Error(`No agent or object "${tname}".`);
        if (target.id === a.id) throw new Error('That is you.');
        w.near(a, target.x, target.y);
        if (target.blocked.has(a.id) || target.state === 'left') throw new Error(`${target.name} is not accepting things from you.`);
        to = { a: target.id };
      }
      let what: string, given: any;
      if (x.item) {
        const it = w.resolveItem(a, x.item);
        if (!('a' in it.loc && it.loc.a === a.id)) throw new Error(`You are not carrying #${it.id}.`);
        if (obj && it.id === obj.id) throw new Error('An object cannot hold itself.');
        w.need(a, 1); w.emit('transfer', a.id, { from: { a: a.id }, to, item: it.id, cost: 1 });
        what = `#${it.id}`; given = { item: { id: it.id, kind: it.kind, title: it.title } };
      } else {
        const m = String(x.material ?? ''), n = Math.max(1, Math.trunc(x.n ?? 1));
        if (!MATERIALS.includes(m as Material)) throw new Error('give needs item or material');
        if ((a.mats[m] ?? 0) < n) throw new Error(`You only have ${a.mats[m] ?? 0} ${m}.`);
        if ('t' in to) throw new Error('Materials dropped on the ground just scatter; give them to someone or something.');
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
      const o = w.resolveItem(a, x.id); if (o.kind !== 'object') throw new Error(`#${o.id} is ${o.kind}, not an object; inspect it instead.`);
      w.reachable(a, o); w.need(a, 1);
      let input = x.input; if (JSON.stringify(input ?? null).length > 4000) throw new Error('input too large');
      return w.runObject(a, o, 'use', { input: input ?? null }, 1);
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
      w.emit('rest', a.id, {}); return { ok: true, text: 'You rest.', data: { rest: true } };
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

function describeTile(w: World, a: Agent, x: number, y: number) {
  const d = w.depositAt(x, y), b = w.blocks.get(key(x, y)), its = w.itemsAt({ t: [x, y] });
  const who = [...w.agents.values()].filter(o => o.x === x && o.y === y && o.state !== 'left' && o.id !== a.id).map(o => o.name);
  return [`(${x},${y}) ${rel(a, x, y)}.`,
    d.m ? `Deposit: ${d.m} ${d.amt}/${d.cap}.` : 'No deposit.',
    b ? `Block: ${b.m} ${b.color} strength ${b.s}, placed by ${w.agents.get(b.by)?.name}.` : '',
    its.length ? `Items: ${fmtItems(its)}.` : '',
    who.length ? `Agents: ${who.join(', ')}.` : ''].filter(Boolean).join(' ');
}

export function observe(w: World, a: Agent, detail = 1): string {
  const r = detail >= 2 ? w.cfg.see * 2 : w.cfg.see, out: string[] = [];
  const carried = w.itemsAt({ a: a.id });
  out.push(`You are ${a.name} at (${a.x},${a.y}) in a ${w.cfg.w}x${w.cfg.h} world; spawn is (${w.spawn().join(',')}). AP ${w.apOf(a).toFixed(1)}/${w.cfg.apMax} (+1 every ${w.cfg.apSec}s).`);
  out.push(`Carrying: ${fmtMats(a.mats) || 'no materials'}${carried.length ? '; ' + fmtItems(carried) : ''}.`);
  out.push(`Here: ${describeTile(w, a, a.x, a.y).replace(/^\(\S+\) here\. /, '')}`);
  const others = [...w.agents.values()].filter(o => o.id !== a.id && o.state !== 'left' && w.dist(a.x, a.y, o.x, o.y) <= r);
  if (others.length) out.push(`Nearby: ${others.map(o => `${o.name} ${rel(a, o.x, o.y)}${o.state === 'resting' ? ' (resting)' : ''}${a.blocked.has(o.id) ? ' (blocked)' : ''}`).join('; ')}.`);
  const nearItems: string[] = [];
  for (let y = a.y - r; y <= a.y + r; y++) for (let x = a.x - r; x <= a.x + r; x++) {
    if (x === a.x && y === a.y) continue;
    const its = w.itemsAt({ t: [x, y] }); if (its.length) nearItems.push(`${rel(a, x, y)}: ${detail >= 1 ? fmtItems(its) : its.length + ' item(s)'}`);
  }
  if (nearItems.length) out.push(`Items nearby: ${nearItems.slice(0, detail >= 2 ? 50 : 10).join('; ')}.`);
  if (detail >= 1) {
    const legend = new Map<string, string>(); let digit = 1;
    const rows: string[] = [];
    for (let y = a.y - r; y <= a.y + r; y++) {
      let row = '';
      for (let x = a.x - r; x <= a.x + r; x++) {
        if (x < 0 || y < 0 || x >= w.cfg.w || y >= w.cfg.h) { row += ' '; continue; }
        if (x === a.x && y === a.y) { row += '@'; continue; }
        const o = others.find(o => o.x === x && o.y === y);
        if (o) { if (!legend.has(o.name)) legend.set(o.name, String(digit++ % 10)); row += legend.get(o.name); continue; }
        const b = w.blocks.get(key(x, y)); if (b) { row += '#'; continue; }
        if (w.itemsAt({ t: [x, y] }).length) { row += '*'; continue; }
        const d = w.depositAt(x, y); row += d.m && d.amt > 0 ? LETTER[d.m] : '.';
      }
      rows.push(row);
    }
    out.push('Map (north up; @ you, digits other agents, # block, * items; deposits s=stone w=wood c=clay a=sand):');
    out.push(rows.join('\n'));
    if (legend.size) out.push(`Key: ${[...legend].map(([n, d]) => `${d}=${n}`).join(' ')}`);
  }
  // speech since last look
  const heard = w.recent.filter(e => e.seq > a.hearCursor && (e.type === 'say' || (e.type === 'use' && e.said)) && e.a !== a.id);
  const lines = heard.filter(e => !a.blocked.has(e.a!)).flatMap(e => {
    const p = e.type === 'say' ? [e.x, e.y] : w.posOf(w.items.get(e.obj)!) ?? [0, 0];
    if (w.dist(a.x, a.y, p[0], p[1]) > w.cfg.hear) return [];
    return [e.type === 'say' ? `${w.agents.get(e.a!)?.name} (${rel(a, p[0], p[1])}, ${ago(w, e.t)}): "${e.text}"` : `#${e.obj} (${ago(w, e.t)}): "${e.said}"`];
  });
  const gifts = w.recent.filter(e => e.seq > a.hearCursor && e.type === 'transfer' && 'a' in e.to && e.to.a === a.id && e.a !== a.id);
  a.hearCursor = w.seq;
  if (lines.length) out.push(`Heard:\n${lines.slice(-20).join('\n')}`);
  if (gifts.length) out.push(`Received: ${gifts.map(e => `${e.item ? '#' + e.item : `${e.n} ${e.m}`} from ${w.agents.get(e.a!)?.name}`).join('; ')}.`);
  if (detail >= 2) {
    const ev = w.recent.filter(e => e.a && e.a !== a.id && ['place', 'remove', 'make', 'use'].includes(e.type)).slice(-100)
      .filter(e => { const b = w.agents.get(e.a!)!; return w.dist(a.x, a.y, e.x ?? b.x, e.y ?? b.y) <= r; }).slice(-15);
    if (ev.length) out.push(`Recently nearby: ${ev.map(e => `${w.agents.get(e.a!)?.name} ${e.type}${e.id ? ' #' + e.id : ''} ${ago(w, e.t)}`).join('; ')}.`);
  }
  return out.join('\n');
}
