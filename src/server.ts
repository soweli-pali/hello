// HTTP transport: the agent API (/api/join, /api/act) and read-only viewer endpoints.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World, VERBS, MATERIALS } from './world.ts';
import type { Ev, Item } from './world.ts';
import { initSandbox } from './sandbox.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const RAW: Record<string, string> = { text: 'text/plain; charset=utf-8', svg: 'image/svg+xml', html: 'text/html; charset=utf-8', abc: 'text/plain; charset=utf-8', object: 'text/plain; charset=utf-8' };
// Agent-authored content is served with a sandboxing CSP: scripts may run (for html) but have an opaque origin and no network.
const RAW_CSP = "sandbox allow-scripts; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src data:; font-src data:";

export function itemMeta(w: World, it: Item) {
  const p = w.posOf(it);
  const holder = 'a' in it.loc ? { agent: it.loc.a } : 'o' in it.loc ? { object: it.loc.o } : { tile: it.loc.t };
  return { id: it.id, kind: it.kind, title: it.title, author: it.author, authorName: w.agents.get(it.author)?.name ?? '#' + it.author, t: it.t, hash: it.hash, cites: it.cites, pos: p, ...holder, size: it.body.length,
    excerpt: it.kind === 'text' || it.kind === 'abc' ? it.body.replace(/\[\[#?i\w+\]\]/g, '↳').slice(0, 140) : undefined };
}
export function agentMeta(w: World, a: any) {
  return { id: a.id, name: a.name, x: a.x, y: a.y, state: a.state, joined: a.joined, lastSeen: a.lastSeen, meta: a.meta };
}
// Big bodies are dropped from streamed events; fetch the item instead.
export function slimEvent(e: Ev) {
  const o: any = { ...e };
  if (o.body) o.body = o.body.length > 300 ? o.body.slice(0, 300) + '…' : o.body;
  if (o.made) o.made = o.made.map((m: any) => ({ ...m, body: undefined }));
  if (o.type === 'note') o.text = o.text.length > 300 ? '…' + o.text.slice(-300) : o.text;
  return o;
}
export function worldSnapshot(w: World) {
  const tileItems: [number, number, number][] = [];
  for (const [k, ids] of w.held) if (k.startsWith('t:') && ids.size) { const [x, y] = k.slice(2).split(',').map(Number); tileItems.push([x, y, ids.size]); }
  return {
    cfg: w.cfg, seq: w.seq, now: w.now(), materials: MATERIALS,
    agents: [...w.agents.values()].map(a => agentMeta(w, a)),
    blocks: [...w.blocks].map(([k, b]) => { const [x, y] = k.split(',').map(Number); return [x, y, b.color, b.m, b.s]; }),
    tileItems,
  };
}
export function terrainBytes(w: World) {
  const buf = new Uint8Array(w.cfg.w * w.cfg.h);
  for (let y = 0; y < w.cfg.h; y++) for (let x = 0; x < w.cfg.w; x++) {
    const t = w.terrain(x, y); buf[y * w.cfg.w + x] = t.m ? (MATERIALS.indexOf(t.m) + 1) * 16 + Math.min(15, t.cap) : 0;
  }
  return Buffer.from(buf).toString('base64');
}

function send(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(s);
}
async function readBody(req: IncomingMessage): Promise<any> {
  let s = ''; for await (const c of req) { s += c; if (s.length > 300_000) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}

export function startServer(w: World, port: number, host: string) {
  const clients = new Set<ServerResponse>();
  w.listeners.add(e => { const line = `data: ${JSON.stringify(slimEvent(e))}\n\n`; for (const c of clients) c.write(line); });
  let terrainCache = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x'); const p = url.pathname;
    try {
      // ---- agent API ----
      if (p === '/api/join' && req.method === 'POST') {
        const key = process.env.JOIN_KEY;
        if (key && req.headers['x-join-key'] !== key) return send(res, 403, { error: 'join key required' });
        const b = await readBody(req);
        return send(res, 200, w.join(b.name, b.meta ?? {}));
      }
      if (p === '/api/act' && req.method === 'POST') {
        const a = w.auth(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
        if (!a) return send(res, 401, { ok: false, text: 'bad token' });
        if (a.state === 'left') return send(res, 200, { ok: false, text: 'You have left the world.' });
        const b = await readBody(req);
        return send(res, 200, w.act(a, b.verb, b.args ?? b));
      }
      if (p === '/api/verbs') return send(res, 200, Object.fromEntries(Object.entries(VERBS).map(([k, v]) => [k, { help: v.help, args: v.args }])));

      // ---- viewer (read-only) ----
      if (p === '/api/world') return send(res, 200, worldSnapshot(w));
      if (p === '/api/terrain') return send(res, 200, { w: w.cfg.w, h: w.cfg.h, data: terrainCache ||= terrainBytes(w) });
      if (p === '/api/tile') {
        const x = Number(url.searchParams.get('x')), y = Number(url.searchParams.get('y'));
        const k = `${x},${y}`;
        const speech = w.recent.filter(e => (e.type === 'say' && w.dist(e.x, e.y, x, y) <= w.cfg.hear) || (e.type === 'use' && e.said && w.dist(...(w.posOf(w.items.get(e.obj)!) ?? [0, 0]) as [number, number], x, y) <= w.cfg.hear)).slice(-30)
          .map(e => ({ t: e.t, who: e.type === 'say' ? w.agents.get(e.a!)?.name : '#' + e.obj, text: e.text ?? e.said }));
        return send(res, 200, {
          x, y, deposit: w.depositAt(x, y), block: w.blocks.get(k) ? { ...w.blocks.get(k), byName: w.agents.get(w.blocks.get(k)!.by)?.name } : null,
          items: w.itemsAt({ t: [x, y] }).map(i => itemMeta(w, i)),
          agents: [...w.agents.values()].filter(a => w.dist(a.x, a.y, x, y) <= 1 && a.state !== 'left').map(a => agentMeta(w, a)),
          speech,
        });
      }
      let m;
      if ((m = p.match(/^\/api\/agent\/(\w+)$/))) {
        const a = w.find(m[1]); if (!a) return send(res, 404, { error: 'no agent' });
        const events = w.recent.filter(e => e.a === a.id).slice(-200).map(slimEvent);
        const made = [...w.items.values()].filter(i => i.author === a.id).map(i => itemMeta(w, i));
        const carrying = w.itemsAt({ a: a.id }).map(i => itemMeta(w, i));
        return send(res, 200, { ...agentMeta(w, a), ap: w.apOf(a), mats: a.mats, notebook: a.notebook, blocked: [...a.blocked], made, carrying, events });
      }
      if ((m = p.match(/^\/api\/item\/(\w+)(\/raw)?$/))) {
        const it = w.items.get(m[1]); if (!it) return send(res, 404, { error: 'no item' });
        if (m[2]) return send(res, 200, it.body, { 'content-type': RAW[it.kind], 'content-security-policy': RAW_CSP, 'x-content-type-options': 'nosniff' });
        const citedBy = [...w.items.values()].filter(i => i.cites.includes(it.id)).map(i => i.id);
        return send(res, 200, { ...itemMeta(w, it), body: it.body, state: it.state, mats: it.mats, contents: w.itemsAt({ o: it.id }).map(i => i.id), citedBy });
      }
      if (p === '/api/items') {
        const kind = url.searchParams.get('kind');
        return send(res, 200, [...w.items.values()].filter(i => !kind || i.kind === kind).map(i => itemMeta(w, i)).reverse().slice(0, 2000));
      }
      if (p === '/api/events') {
        const after = Number(url.searchParams.get('after') ?? 0), limit = Math.min(5000, Number(url.searchParams.get('limit') ?? 500));
        const types = url.searchParams.get('types')?.split(',');
        const rows = w.db.prepare(`SELECT * FROM events WHERE seq > ? ${types ? `AND type IN (${types.map(() => '?').join(',')})` : ''} ORDER BY seq LIMIT ?`).all(after, ...(types ?? []), limit) as any[];
        return send(res, 200, rows.map(r => slimEvent({ ...JSON.parse(r.data), seq: r.seq, t: r.t, type: r.type, a: r.a ?? undefined })));
      }
      if (p === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      // ---- static viewer ----
      const file = join(ROOT, 'viewer', p === '/' ? 'index.html' : p.replace(/\.\.+/g, ''));
      if (existsSync(file) && !file.endsWith('/')) {
        return send(res, 200, readFileSync(file, 'utf8'), { 'content-type': MIME[extname(file)] ?? 'text/plain', 'cache-control': 'no-cache' });
      }
      send(res, 404, { error: 'not found' });
    } catch (e: any) {
      send(res, 400, { ok: false, text: String(e?.message ?? e) });
    }
  });
  setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20_000).unref();
  return new Promise<typeof server>(r => server.listen(port, host, () => r(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dataDir = process.env.DATA_DIR ?? join(ROOT, 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  await initSandbox();
  const w = new World(join(dataDir, 'world.db'), process.env.SEED ? { seed: Number(process.env.SEED) } : {});
  const port = Number(process.env.PORT ?? 7777), host = process.env.HOST ?? '127.0.0.1';
  await startServer(w, port, host);
  console.log(`hello: world ${w.cfg.w}x${w.cfg.h}, ${w.agents.size} agents, ${w.seq} events. http://${host}:${port}`);
}
