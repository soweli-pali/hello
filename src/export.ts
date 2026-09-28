// Static snapshot for GitHub Pages or any file host: node src/export.ts [outDir] [--notebooks]
// Notebooks are left out unless asked: agents were told the observer can read them, not the public.
// --artifact writes a page for a claude.ai Artifact (no document wrapper, a lean set of files) for private viewing.
import { mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from './world.ts';
import { initSandbox } from './sandbox.ts';
import { worldSnapshot, terrainBytes, elevBytes, itemMeta, agentMeta, slimEvent, animalsNow } from './server.ts';
import { RECIPES, rulesText } from './world.ts';
import { SPECIES } from './fauna.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), withNotes = args.includes('--notebooks'), artifact = args.includes('--artifact');
const out = args.find(a => !a.startsWith('--')) ?? join(ROOT, 'dist');
const EXT: Record<string, string> = { text: 'txt', svg: 'svg', html: 'html', abc: 'txt', object: 'txt' };
const META_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src data:; font-src data:">`;

await initSandbox();
const w = new World(join(process.env.DATA_DIR ?? join(ROOT, 'data'), 'world.db'));
// a snapshot shows the world as of its latest moment, which for a simulation is its own virtual time
const lastT = (w.db.prepare('SELECT max(t) t FROM events WHERE a IS NOT NULL').get() as any)?.t;
if (lastT) w.now = () => lastT;
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const put = (p: string, v: unknown) => { const f = join(out, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };

for (const f of ['app.js', 'tiles.js', 'style.css']) copyFileSync(join(ROOT, 'viewer', f), join(out, f));
const replay = args.includes('--replay'); // open straight into the replay
put('static.js', `window.HELLO_STATIC = true;${replay ? ' window.HELLO_REPLAY = true;' : ''}`);
let page = readFileSync(join(ROOT, 'viewer', 'index.html'), 'utf8').replace('<script src="app.js">', '<script src="static.js"></script><script src="app.js">');
if (artifact) page = page.replace(/<!doctype html>|<\/?html[^>]*>|<\/?head>|<\/?body>|<meta [^>]*>/gi, '').trim();
put('index.html', page);
put('data/world.json', worldSnapshot(w));
put('data/animals.json', { phase: w.phase(), animals: animalsNow(w) });
put('data/rules.json', { text: rulesText(w.cfg), cfg: w.cfg, recipes: RECIPES, species: SPECIES });
put('data/terrain.json', { w: w.cfg.w, h: w.cfg.h, data: terrainBytes(w), elev: elevBytes(w) });
const items = [...w.items.values()];
put('data/items.json', items.map(i => itemMeta(w, i)).reverse());
for (const it of items) {
  const citedBy = items.filter(i => i.cites.includes(it.id)).map(i => i.id);
  put(`data/item/${it.id}.json`, { ...itemMeta(w, it), body: it.body, state: it.state, mats: it.mats, contents: w.itemsAt({ o: it.id }).map(i => i.id), citedBy });
  if (EXT[it.kind]) put(`data/raw/${it.id}.${EXT[it.kind]}`, it.kind === 'html' ? META_CSP + it.body : it.body);
}
const events = w.db.prepare('SELECT * FROM events ORDER BY seq').all() as any[];
const evs = events.map(r => slimEvent({ ...JSON.parse(r.data), seq: r.seq, t: r.t, type: r.type, a: r.a ?? undefined }));
put('data/events.json', evs.filter(e => e.type !== 'note' || withNotes));
for (const a of w.agents.values()) {
  const page = { ...agentMeta(w, a), ap: w.apOf(a), vig: w.vigOf(a), vigMax: w.cfg.vigorMax, load: w.load(a), capacity: w.capacity(a), deadUntil: a.deadUntil, pets: w.tamed(a).map(p => p.id), mats: a.mats, notebook: withNotes ? a.notebook : '(notebooks are not included in public snapshots)', blocked: [...a.blocked],
    made: items.filter(i => i.author === a.id).map(i => itemMeta(w, i)), carrying: w.itemsAt({ a: a.id }).map(i => itemMeta(w, i)),
    events: evs.filter(e => e.a === a.id && (e.type !== 'note' || withNotes)).slice(-200) };
  put(`data/agent/${a.id}.json`, page); put(`data/agent/${encodeURIComponent(a.name)}.json`, page);
}
const tiles = new Set<string>([...w.blocks.keys()]);
for (const k of w.held.keys()) if (k.startsWith('t:')) tiles.add(k.slice(2));
for (const a of w.agents.values()) tiles.add(`${a.x},${a.y}`);
for (const k of artifact ? [...w.agents.values()].map(a => `${a.x},${a.y}`) : tiles) {
  const [x, y] = k.split(',').map(Number), b = w.blocks.get(k);
  put(`data/tile/${x}_${y}.json`, { x, y, deposit: w.depositAt(x, y), block: b ? { ...b, byName: w.agents.get(b.by)?.name } : null,
    items: w.itemsAt({ t: [x, y] }).map(i => itemMeta(w, i)), agents: [...w.agents.values()].filter(a => w.dist(a.x, a.y, x, y) <= 1 && a.state !== 'left').map(a => agentMeta(w, a)),
    speech: evs.filter(e => e.type === 'say' && w.dist(e.x, e.y, x, y) <= w.cfg.hear).slice(-30).map(e => ({ t: e.t, who: w.agents.get(e.a!)?.name, text: e.text })) });
}
// --single: one self-contained page (code, styles and data inlined), for viewers that can't fetch side files
if (args.includes('--single')) {
  const { readdirSync, statSync } = await import('node:fs');
  const data: Record<string, string> = {};
  const walk = (d: string) => { for (const f of readdirSync(join(out, d))) { const p = d ? `${d}/${f}` : f; statSync(join(out, p)).isDirectory() ? walk(p) : p.startsWith('data/') && (data[p] = readFileSync(join(out, p), 'utf8')); } };
  walk('');
  const inline = (f: string) => readFileSync(join(out, f), 'utf8').replace(/<\/script/gi, '<\\/script');
  const one = page
    .replace('<link rel="stylesheet" href="style.css">', `<style>${readFileSync(join(out, 'style.css'), 'utf8')}</style>`)
    .replace('<script src="static.js"></script>', `<script>window.HELLO_STATIC = true;${replay ? ' window.HELLO_REPLAY = true;' : ''} window.HELLO_DATA = ${JSON.stringify(data).replace(/<\//g, '<\\/')};</script>`)
    .replace('<script src="tiles.js"></script>', `<script>${inline('tiles.js')}</script>`)
    .replace('<script src="app.js"></script>', `<script>${inline('app.js')}</script>`);
  writeFileSync(join(out, 'single.html'), one);
}
console.log(`exported ${items.length} items, ${w.agents.size} agents, ${tiles.size} tiles, ${evs.length} events to ${out}${withNotes ? ' (with notebooks)' : ''}`);
