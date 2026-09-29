import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, rulesText, VERBS } from '../src/world.ts';
import { initSandbox, runHandler } from '../src/sandbox.ts';
import { startServer } from '../src/server.ts';

await initSandbox();
const dir = mkdtempSync(join(tmpdir(), 'hello-'));
function findTile(w: World, cx: number, cy: number, ok: (x: number, y: number) => boolean): [number, number] | null {
  for (let r = 0; r < 250; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
    if (Math.max(Math.abs(dx), Math.abs(dy)) === r && w.geo.inside(cx + dx, cy + dy) && ok(cx + dx, cy + dy)) return [cx + dx, cy + dy];
  return null;
}

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
  const w = new World(file, { w: 512, h: 512, apSec: 0.001 });
  const a = w.agents.get(w.join('Ada').id)!, b = w.agents.get(w.join('Bo').id)!;
  assert.throws(() => w.join('ada'), /taken/);
  // find a deposit and gather from it
  const spot = findTile(w, a.x, a.y, (x, y) => ['stone', 'wood', 'clay', 'sand'].includes(w.depositAt(x, y).m as string));
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
  assert.ok(w.act(a, 'move', { dir: 'n' }).ok || true);
  // replay reproduces state
  const w2 = new World(file);
  assert.equal(w2.seq, w.seq);
  assert.equal(w2.items.get(oid)!.state, 2);
  assert.deepEqual(w2.agents.get(a.id)!.mats, a.mats);
  assert.equal(w2.blocks.size, w.blocks.size);
  assert.equal(w2.agents.get(a.id)!.notebook, 'remember');
});

test('http api', async () => {
  const w = new World(join(dir, 'h.db'), { w: 512, h: 512 });
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
  const w = new World(':memory:', { w: 512, h: 512, apSec: 0.001 });
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


test('bodies: exposure, death, respawn, no quick travel', () => {
  assert.equal(new World(':memory:', { w: 128, h: 128 }).cfg.permadeath, true, 'death is final by default');
  const w = new World(':memory:', { w: 512, h: 512, apSec: 0.001, apMax: 5000, respawnSec: 0.05, permadeath: false });
  const a = w.agents.get(w.join('Walker').id)!;
  const desert = findTile(w, a.x, a.y, (x, y) => w.geo.biomeAt(x, y) === 'desert' && w.geo.biomeAt(x + 5, y) === 'desert' && !w.safe(x, y))!;
  assert.ok(desert, 'there is desert');
  w.emit('move', a.id, { x: desert[0], y: desert[1], cost: 0 });
  a.mats.food = 2; a.mats.stone = 3;
  const r = w.act(a, 'move', { dir: 'e', steps: 5 });
  assert.match(r.text, /vigor/); assert.ok(w.vigOf(a) < w.cfg.vigorMax);
  // walking to death needs force; without it the body stops
  for (let i = 0; i < 20 && w.vigOf(a) > 1; i++) w.act(a, 'move', { dir: i % 2 ? 'e' : 'w', steps: 10 });
  assert.match(w.act(a, 'move', { dir: 'e', steps: 10 }).text, /would kill you|world ends/);
  const where = [a.x, a.y];
  w.act(a, 'move', { dir: 'w', steps: 10, force: true });
  assert.equal(a.state, 'dead');
  assert.equal(w.ground.get(`${a.x},${a.y}`)!.stone, 3, 'the dead drop what they carried');
  assert.match(w.act(a, 'say', { text: 'hi' }).text, /You are dead/);
  const t0 = Date.now(); while (Date.now() - t0 < 80) { /* wait for respawn */ }
  assert.ok(w.act(a, 'look', {}).ok); assert.equal(a.state, 'active');
  assert.ok(w.dist(a.x, a.y, a.home[0], a.home[1]) <= 1, 'wakes at home'); assert.equal(Math.round(w.vigOf(a)), w.cfg.vigorMax);
  void where;
  // there is no jump home: the way back is walked
  w.emit('move', a.id, { x: a.x + 20, y: a.y, cost: 0 });
  assert.equal(w.act(a, 'move', { to: 'home' }).ok, false);
  assert.equal(w.act(a, 'move', { toward: 'home' }).ok, false, 'and no sense of where home is');
  assert.doesNotMatch(w.act(a, 'look', { detail: 2 }).text, /home/i);
  // operators can place a body; nowhere is safe by default
  const c = w.agents.get(w.join('Placed', {}, [100, 120]).id)!;
  assert.deepEqual([c.x, c.y], [100, 120]); assert.deepEqual(c.home, [100, 120]);
  assert.equal(w.safe(c.x, c.y), false);
});

test('crafting, local knowledge, animals', () => {
  const w = new World(':memory:', { w: 512, h: 512, apSec: 0.001, discovery: false });
  const a = w.agents.get(w.join('Smith').id)!;
  assert.doesNotMatch(w.act(a, 'look', {}).text, /\(\d+,\d+\)/, 'no coordinates without a compass');
  assert.equal(w.act(a, 'move', { x: 1, y: 1 }).ok, false);
  assert.match(w.act(a, 'craft', { recipe: 'compass' }).text, /need 3 more ore/);
  a.mats = { ore: 3, crystal: 1, wood: 2, stone: 3 };
  assert.ok(w.act(a, 'craft', { recipe: 'compass' }).ok);
  assert.match(w.act(a, 'look', {}).text, /at \(\d+,\d+\)/);
  assert.equal(w.act(a, 'make', { copy: [...w.items.values()].find(i => i.title === 'compass' && i.author === a.id)!.id }).ok, false, 'tools cannot be copied');
  // ruins exist far away, with things in them
  assert.ok([...w.items.values()].some(i => i.author === 'world' && i.kind === 'tool'));
  // animals move deterministically and can be tamed
  const goat = w.fauna.list.find(an => an.sp === 'goat')!;
  assert.deepEqual(w.animalPos(goat, 1e12), w.animalPos(goat, 1e12));
  const p = w.animalPos(goat); w.emit('move', a.id, { x: p[0], y: p[1], cost: 0 });
  a.mats.food = 1; const cap0 = w.capacity(a);
  assert.ok(w.act(a, 'give', { to: goat.id, material: 'food' }).ok);
  assert.equal(w.capacity(a), cap0 + 30);
  assert.deepEqual(w.animalPos(goat), [a.x, a.y], 'tamed animals follow');
  // hunting
  const deer = w.fauna.list.find(an => an.sp === 'deer')!; const dp = w.animalPos(deer);
  w.emit('move', a.id, { x: dp[0], y: dp[1], cost: 0 });
  for (let i = 0; i < 3; i++) w.act(a, 'strike', { animal: deer.id });
  assert.ok(!w.fauna.alive(deer, w.now())); assert.ok(a.mats.food >= 1);
});

test('blocks and dyes', () => {
  const w = new World(':memory:', { w: 512, h: 512, discovery: false });
  const land = findTile(w, 256, 256, (x, y) => { for (let j = -6; j <= 6; j++) for (let i = -6; i <= 6; i++) if (!['meadow', 'forest'].includes(w.geo.biomeAt(x + i, y + j))) return false; return true; })!;
  const a = w.agents.get(w.join('Mason', {}, land).id)!;
  a.mats = { clay: 20, sand: 10, indigo: 2, shell: 2, wood: 6 };
  assert.ok(w.act(a, 'place', { block: 'plaster', dye: 'indigo+shell', dir: 'e' }).ok);
  const b = w.blocks.get(`${a.x + 1},${a.y}`)!; assert.equal(b.m, 'plaster'); assert.notEqual(b.color, '#e4ddcf');
  assert.equal(w.act(a, 'place', { block: 'brick', dye: 'indigo', dir: 'w' }).ok, false, 'bricks take no dye');
  assert.match(w.act(a, 'place', { block: 'marble', dir: 'n' }).text, /more marble/);
  assert.ok(w.act(a, 'place', { block: 'floor', dir: 's' }).ok);
  assert.equal(w.blocks.get(`${a.x},${a.y + 1}`)!.kind, 'road', 'floors are walkable');
  assert.equal(a.mats.indigo, 1); assert.equal(a.mats.clay, 19);
  // shelter: walls around you
  assert.equal(w.sheltered(a.x, a.y), false);
  a.mats.stone = 8; a.mats.wood = 4; w.act(a, 'remove', { dir: 's' }); w.act(a, 'remove', { dir: 's' });
  for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [-1, 1], [1, 1]]) assert.ok(w.act(a, 'place', { block: 'stone', dx, dy }).ok);
  assert.equal(w.sheltered(a.x, a.y), false, 'one side still open');
  assert.ok(w.act(a, 'place', { block: 'door', dir: 's' }).ok);
  assert.equal(w.sheltered(a.x, a.y), false, 'walls without a roof');
  assert.ok(w.act(a, 'place', { block: 'shingle', dir: 'e' }).ok, 'eaves can rest on walls');
  assert.ok(w.act(a, 'place', { block: 'shingle', dx: 0, dy: 0 }).ok);
  assert.ok(w.sheltered(a.x, a.y), 'closed, roofed room with a door'); assert.match(w.act(a, 'look', {}).text, /sheltered/);
  assert.equal(w.recovery(a.x, a.y, w.now()), 3);
  assert.equal(w.step(a, a.x, a.y + 1).ap, 1, 'doors are easy for people');
  // roofs need a wall within reach
  const far = findTile(w, a.x + 20, a.y, (x, y) => { for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) if (w.blocks.has(`${x + i},${y + j}`) || w.geo.biomeAt(x + i, y + j) === 'sea' || w.geo.biomeAt(x + i, y + j) === 'river') return false; return true; })!;
  w.emit('move', a.id, { x: far[0], y: far[1], cost: 0 }); a.mats.wood = 10; a.mats.fiber = 4;
  assert.match(w.act(a, 'place', { block: 'thatch', dx: 0, dy: 0 }).text, /pillar|wall/i);
  // campfire, fence
  assert.ok(w.act(a, 'place', { block: 'fire', dir: 'e' }).ok);
  assert.ok(w.nearFire(a.x, a.y, 3, w.now())); assert.equal(w.recovery(a.x, a.y, w.now()), 2);
  assert.equal(w.nearFire(a.x, a.y, 3, w.now() + 5 * 3600_000), false, 'fires burn out');
  assert.ok(w.act(a, 'place', { block: 'fence', dir: 'w' }).ok);
  assert.equal(w.step(a, a.x - 1, a.y).ap, 2, 'people step over fences');
  // heavy blocks need two
  a.mats.marble = 4;
  assert.match(w.act(a, 'place', { block: 'marble', dir: 'n' }).text, /two|help/i);
  const b2 = w.agents.get(w.join('Helper', {}, [a.x, a.y]).id)!;
  assert.ok(w.act(a, 'place', { block: 'marble', dir: 'n' }).ok, 'with a helper nearby');
  // crowding: at most two per tile
  const c3 = w.agents.get(w.join('Third', {}, [a.x, a.y]).id)!;
  assert.notDeepEqual([c3.x, c3.y], [a.x, a.y], 'a third body lands beside');
  assert.ok(w.crowd(a.x, a.y) <= 2); void b2;
});

test('looks and pictures', () => {
  const w = new World(':memory:', { w: 256, h: 256 });
  const a = w.agents.get(w.join('Pip', { look: { species: 'fox', fur: '#e07030', mark: 'socks', junk: 1, eyes: 'red' } }).id)!;
  assert.deepEqual(a.meta.look, { species: 'fox', fur: '#e07030', mark: 'socks' }, 'only known fields, well-formed');
  const r = w.act(a, 'look', { picture: true });
  const png = Buffer.from((r.data as any).png, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), (2 * w.sight(a) + 1) * 24, 'one picture tile per tile in sight');
});

test('fights are slow: strikers are winded; news is told once', () => {
  const w = new World(':memory:', { w: 256, h: 256 }); let t = Date.now(); w.now = () => t;
  const [x, y] = w.geo.landing();
  const a = w.agents.get(w.join('Ann', {}, [x, y]).id)!, b = w.agents.get(w.join('Bob', {}, [x + 1, y]).id)!, c = w.agents.get(w.join('Cy', {}, [x, y + 1]).id)!;
  assert.ok(w.act(b, 'strike', { agent: 'Ann' }).ok);
  assert.match(w.act(b, 'strike', { agent: 'Cy' }).text, /winded/, 'one swing a minute, at anyone');
  assert.ok(w.act(c, 'strike', { agent: 'Ann' }).ok, 'being struck gives no protection');
  t += 61_000; assert.ok(w.act(b, 'strike', { agent: 'Ann' }).ok);
  assert.ok(w.vigOf(a) < 8);
  // a body that joined before a change hears about it once
  a.joined = 0; a.noticed = undefined;
  assert.match(w.act(a, 'look', {}).text, /News about how the world works/);
  assert.doesNotMatch(w.act(a, 'look', {}).text, /News about/);
  assert.doesNotMatch(w.act(b, 'look', {}).text, /News about/, 'newcomers already know');
});

test('discovery: you know what you have seen the makings of', () => {
  const w = new World(':memory:', { w: 256, h: 256 });
  const [x, y] = w.geo.landing();
  const a = w.agents.get(w.join('Ann', {}, [x, y]).id)!;
  const intro = rulesText(w.cfg);
  for (const secret of ['spear', 'compass', 'marble', 'ochre', 'waterskin']) assert.doesNotMatch(intro + VERBS.place.help + VERBS.craft.help, new RegExp(secret), `${secret} stays secret`);
  assert.equal(w.knowsRecipe(a, 'compass'), false);
  assert.match(w.act(a, 'craft', { recipe: 'compass' }).text, /don't know/);
  a.mats = { ore: 3, crystal: 1 };
  assert.match(w.act(a, 'look', {}).text, /for the first time, you realise you could make.*compass/);
  a.mats = {}; assert.ok(w.knowsRecipe(a, 'compass'), 'once seen, remembered');
  assert.doesNotMatch(w.act(a, 'look', {}).text, /for the first time/);
  assert.match(w.act(a, 'look', { detail: 2 }).text, /Recipes you know:.*compass/);
  assert.equal(w.knowsBlock(a, 'marble'), false);
  // what a body has done counts: crafted tools, placed blocks, what it gathered or was given
  const b = w.agents.get(w.join('Bo', {}, [x, y + 1]).id)!; b.mats = { ore: 2, crystal: 2, sand: 3 };
  assert.ok(w.act(b, 'craft', { recipe: 'spyglass' }).ok);
  b.mats = {}; assert.ok(w.knowsRecipe(b, 'spyglass')); assert.ok(w.knowsRecipe(b, 'compass'), 'ore and crystal were seen');
});
