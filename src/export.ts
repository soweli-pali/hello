// Static snapshot for GitHub Pages or any file host: node src/export.ts [outDir] [--notebooks]
// Notebooks are left out unless asked: agents were told the observer can read them, not the public.
import { mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from './world.ts';
import { initSandbox } from './sandbox.ts';
import { worldSnapshot, terrainBytes, elevBytes, itemMeta, agentMeta, slimEvent, animalsNow } from './server.ts';
import { RECIPES, rulesText } from './world.ts';
import { SPECIES } from './fauna.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), withNotes = args.includes('--notebooks');
const out = args.find(a => !a.startsWith('--')) ?? join(ROOT, 'dist');
const EXT: Record<string, string> = { text: 'txt', svg: 'svg', html: 'html', abc: 'txt', object: 'txt' };
const META_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src data:; font-src data:">`;

await initSandbox();
const w = new World(join(process.env.DATA_DIR ?? join(ROOT, 'data'), 'world.db'));
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const put = (p: string, v: unknown) => { const f = join(out, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };

for (const f of ['app.js', 'tiles.js', 'style.css']) copyFileSync(join(ROOT, 'viewer', f), join(out, f));
put('static.js', 'window.HELLO_STATIC = true;');
put('index.html', readFileSync(join(ROOT, 'viewer', 'index.html'), 'utf8').replace('<script src="app.js">', '<script src="static.js"></script><script src="app.js">'));
put('data/world.json', worldSnapshot(w));
put('data/animals.json', { phase: w.phase(), animals: animalsNow(w) });
put('data/rules.json', { text: rulesText(w.cfg), cfg: w.cfg, recipes: RECIPES, species: SPECIES });
put('data/terrain.json', { w: w.cfg.w, h: w.cfg.h, data: terrainBytes(w), elev: elevBytes(w) });
const items = [...w.items.values()];
put('data/items.json', items.map(i => itemMeta(w, i)).reverse());
for (const it of items) {
  const citedBy = items.filter(i => i.cites.includes(it.id)).map(i => i.id);
  put(`data/item/${it.id}.json`, { ...itemMeta(w, it), body: it.body, state: it.state, mats: it.mats, contents: w.itemsAt({ o: it.id }).map(i => i.id), citedBy });
  put(`data/raw/${it.id}.${EXT[it.kind]}`, it.kind === 'html' ? META_CSP + it.body : it.body);
}
const events = w.db.prepare('SELECT * FROM events ORDER BY seq').all() as any[];
const evs = events.map(r => slimEvent({ ...JSON.parse(r.data), seq: r.seq, t: r.t, type: r.type, a: r.a ?? undefined }));
put('data/events.json', evs.filter(e => e.type !== 'note' || withNotes));
for (const a of w.agents.values()) {
  const page = { ...agentMeta(w, a), ap: w.apOf(a), mats: a.mats, notebook: withNotes ? a.notebook : '(notebooks are not included in public snapshots)', blocked: [...a.blocked],
    made: items.filter(i => i.author === a.id).map(i => itemMeta(w, i)), carrying: w.itemsAt({ a: a.id }).map(i => itemMeta(w, i)),
    events: evs.filter(e => e.a === a.id && (e.type !== 'note' || withNotes)).slice(-200) };
  put(`data/agent/${a.id}.json`, page); put(`data/agent/${encodeURIComponent(a.name)}.json`, page);
}
const tiles = new Set<string>([...w.blocks.keys()]);
for (const k of w.held.keys()) if (k.startsWith('t:')) tiles.add(k.slice(2));
for (const a of w.agents.values()) tiles.add(`${a.x},${a.y}`);
for (const k of tiles) {
  const [x, y] = k.split(',').map(Number), b = w.blocks.get(k);
  put(`data/tile/${x}_${y}.json`, { x, y, deposit: w.depositAt(x, y), block: b ? { ...b, byName: w.agents.get(b.by)?.name } : null,
    items: w.itemsAt({ t: [x, y] }).map(i => itemMeta(w, i)), agents: [...w.agents.values()].filter(a => w.dist(a.x, a.y, x, y) <= 1 && a.state !== 'left').map(a => agentMeta(w, a)),
    speech: evs.filter(e => e.type === 'say' && w.dist(e.x, e.y, x, y) <= w.cfg.hear).slice(-30).map(e => ({ t: e.t, who: w.agents.get(e.a!)?.name, text: e.text })) });
}
console.log(`exported ${items.length} items, ${w.agents.size} agents, ${tiles.size} tiles, ${evs.length} events to ${out}${withNotes ? ' (with notebooks)' : ''}`);
