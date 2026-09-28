import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../src/world.ts';
import { initSandbox, runHandler } from '../src/sandbox.ts';
import { startServer } from '../src/server.ts';

await initSandbox();
const dir = mkdtempSync(join(tmpdir(), 'hello-'));

test('sandbox limits', () => {
  assert.deepEqual(runHandler('function use(c){return c.input*2}', 'use', { input: 21 }), { ok: true, value: 42 });
  const loop = runHandler('function use(){ while(true){} }', 'use', {});
  assert.equal(loop.ok, false); assert.match((loop as any).error, /gas/);
  const mem = runHandler('function use(){ const a=[]; while(true) a.push("x".repeat(1e5)) }', 'use', {});
  assert.equal(mem.ok, false);
  assert.equal(runHandler('syntax error here', '__compile', {}).ok, false);
  assert.equal(runHandler('var x = 1', 'use', {}).missing, true);
  const io = runHandler('function use(){ return typeof require + typeof fetch + typeof process }', 'use', {});
  assert.deepEqual(io, { ok: true, value: 'undefinedundefinedundefined' });
});

test('world, verbs, replay', () => {
  const file = join(dir, 'w.db');
  const w = new World(file, { apSec: 0.001 });
  const a = w.agents.get(w.join('Ada').id)!, b = w.agents.get(w.join('Bo').id)!;
  assert.throws(() => w.join('ada'), /taken/);
  // find a deposit and gather from it
  let spot: [number, number] | null = null;
  for (let r = 0; r < 60 && !spot; r++) for (let x = a.x - r; x <= a.x + r && !spot; x++) if (w.depositAt(x, a.y + r).amt > 0) spot = [x, a.y + r];
  assert.ok(spot, 'there are deposits');
  w.emit('move', a.id, { x: spot![0], y: spot![1], cost: 0 });
  assert.ok(w.act(a, 'gather', { n: 2 }).ok);
  const mat = Object.keys(a.mats)[0];
  assert.ok(w.act(a, 'place', { material: mat, color: '#ff0000', dir: 'e' }).ok);
  assert.ok(w.blocks.has(`${a.x + 1},${a.y}`));
  // artifacts + citation
  const r1 = w.act(a, 'make', { kind: 'text', title: 'hi', body: 'hello world' }); assert.ok(r1.ok);
  const id1 = (r1.data as any).id;
  const r2 = w.act(a, 'make', { kind: 'text', title: 're', body: `after [[#${id1}]]` });
  assert.deepEqual(w.items.get((r2.data as any).id)!.cites, [id1]);
  // a counter object
  const ro = w.act(a, 'make', { kind: 'object', title: 'counter', body: 'function use(c){ const n=(c.state||0)+1; return {reply:"count "+n, state:n, say: n===2?"two!":undefined} }' });
  const oid = (ro.data as any).id;
  assert.match(w.act(a, 'use', { id: oid }).text, /count 1/);
  assert.match(w.act(a, 'use', { id: oid }).text, /count 2/);
  assert.equal(w.act(a, 'make', { kind: 'object', title: 'bad', body: 'function (' }).ok, false);
  // give, block
  w.emit('move', b.id, { x: a.x, y: a.y, cost: 0 });
  assert.ok(w.act(a, 'give', { to: 'Bo', item: id1 }).ok);
  assert.ok(w.act(b, 'block', { agent: 'Ada' }).ok);
  assert.equal(w.act(a, 'give', { to: 'Bo', item: (r2.data as any).id }).ok, false);
  assert.ok(w.act(a, 'give', { to: 'ground', item: oid }).ok);
  assert.equal(w.act(b, 'gather', { item: oid }).ok, false, 'objects are anchored by default');
  assert.ok(w.act(a, 'note', { text: 'remember' }).ok);
  assert.match(w.act(a, 'look', { detail: 2 }).text, /You are Ada/);
  assert.ok(w.act(a, 'move', { to: 'spawn' }).ok);
  // replay reproduces state
  const w2 = new World(file);
  assert.equal(w2.seq, w.seq);
  assert.equal(w2.items.get(oid)!.state, 2);
  assert.deepEqual(w2.agents.get(a.id)!.mats, a.mats);
  assert.equal(w2.blocks.size, w.blocks.size);
  assert.equal(w2.agents.get(a.id)!.notebook, 'remember');
});

test('http api', async () => {
  const w = new World(join(dir, 'h.db'));
  const srv = await startServer(w, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const j = await (await fetch(base + '/api/join', { method: 'POST', body: JSON.stringify({ name: 'Cy' }) })).json();
  const act = (body: any) => fetch(base + '/api/act', { method: 'POST', headers: { authorization: 'Bearer ' + j.token }, body: JSON.stringify(body) }).then(r => r.json());
  assert.match((await act({ verb: 'look' })).text, /You are Cy/);
  assert.ok((await act({ verb: 'say', text: 'hi' })).ok);
  assert.equal((await fetch(base + '/api/act', { method: 'POST', body: '{}' })).status, 401);
  const snap = await (await fetch(base + '/api/world')).json();
  assert.equal(snap.agents.length, 1);
  srv.close();
});

test('objects hold things and trade by their own rules', () => {
  const w = new World(':memory:', { apSec: 0.001 });
  const a = w.agents.get(w.join('Maker').id)!, b = w.agents.get(w.join('Buyer').id)!;
  w.emit('move', b.id, { x: a.x, y: a.y, cost: 0 });
  a.mats.stone = 5; b.mats.wood = 3; // test setup only; normally gathered
  // swaps 1 wood for 1 stone; refuses (returns the gift) when empty
  const code = `function receive(c){
    if (c.user.id === c.self.author) return { reply: 'stocked' };
    if (c.given.material !== 'wood') return { reply: 'wood only', give: c.given.item ? [{ item: c.given.item.id }] : [{ material: c.given.material, n: c.given.n }] };
    if (!(c.holdings.materials.stone > 0)) return { reply: 'out of stone', give: [{ material: 'wood', n: c.given.n }] };
    return { reply: 'thanks', give: [{ material: 'stone', n: 1 }], state: { trades: ((c.state && c.state.trades) || 0) + 1 } };
  }
  function use(){ return { give: [{ material: 'stone', n: 99 }], reply: 'nice try' }; }`;
  const oid = (w.act(a, 'make', { kind: 'object', title: 'swap', body: code }).data as any).id;
  assert.ok(w.act(a, 'give', { to: oid, material: 'stone', n: 2 }).ok);
  assert.ok(w.act(a, 'give', { to: 'ground', item: oid }).ok);
  assert.match(w.act(b, 'give', { to: oid, material: 'wood', n: 1 }).text, /thanks.*received 1 stone/);
  assert.equal(b.mats.stone, 1);
  w.act(b, 'use', { id: oid });
  assert.equal(b.mats.stone, 1, 'an object cannot give what it does not hold');
  w.act(b, 'give', { to: oid, material: 'wood', n: 1 });
  assert.match(w.act(b, 'give', { to: oid, material: 'wood', n: 1 }).text, /out of stone/);
  assert.equal(b.mats.wood, 1); assert.equal(b.mats.stone, 2);
  assert.deepEqual(w.items.get(oid)!.state, { trades: 2 });
  assert.equal(w.items.get(oid)!.mats!.wood, 2);
});
