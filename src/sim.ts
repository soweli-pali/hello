// Fast simulation: scripted bots in-process on a virtual clock. Hours of world in seconds, zero tokens.
//   node src/sim.ts [out.db] --bots 30 --hours 6 --seed 7
// Open the result with DATA_DIR=<dir of out.db> npm start (the file must be named world.db).
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { World } from './world.ts';
import { initSandbox } from './sandbox.ts';
import { bot } from './runner.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: number) => { const i = args.indexOf('--' + k); return i >= 0 ? Number(args[i + 1]) : d; };
const out = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'data/sim/world.db';
const nBots = opt('bots', 30), hours = opt('hours', 6), seed = opt('seed', 7), step = 2000; // ms of world time per tick

mkdirSync(dirname(out), { recursive: true }); rmSync(out, { force: true }); rmSync(out + '-wal', { force: true }); rmSync(out + '-shm', { force: true });
await initSandbox();
let clock = Date.now() - hours * 3600_000;
const w = new World(out, { seed });
w.now = () => clock;
const names = ['Wren', 'Pim', 'Oso', 'Tuk', 'Mira', 'Fen', 'Juno', 'Rue', 'Ivo', 'Sel', 'Aya', 'Bex', 'Cato', 'Dov', 'Esk', 'Fia', 'Gil', 'Hap', 'Ina', 'Jot', 'Kip', 'Lua', 'Mox', 'Nel', 'Ode', 'Pax', 'Quin', 'Ria', 'Sol', 'Tam'];
const bots = Array.from({ length: nBots }, (_, i) => {
  const name = names[i % names.length] + (i >= names.length ? String(i) : '');
  const { id } = w.join(name, { provider: 'bot' });
  return { a: w.agents.get(id)!, think: bot({ name, provider: 'bot', seed: i + 1 }), next: clock + Math.random() * 5000 };
});
const end = clock + hours * 3600_000; let ticks = 0;
while (clock < end) {
  clock += step; ticks++;
  for (const b of bots) {
    if (clock < b.next) continue;
    const obs = w.act(b.a, 'look', { detail: 1 }).text;
    if (/^You are dead/.test(obs)) { b.next = clock + 30_000; continue; }
    const r = await b.think('', `[Now]\n${obs}`, null);
    let rest = false;
    for (const c of r.calls) { const res = w.act(b.a, c.verb, c.args); if ((res.data as any)?.rest) rest = true; }
    b.next = clock + (rest ? 120_000 : 15_000 + Math.random() * 15_000); // a turn every 15-30s of world time; AP is the real limit
  }
}
const count = (t: string) => w.db.prepare('SELECT count(*) n FROM events WHERE type=?').get(t) as any;
console.log(`simulated ${hours}h with ${nBots} bots: ${w.seq} events, ${w.blocks.size} blocks, ${[...w.items.values()].filter(i => i.kind === 'tool' && i.author !== 'world').length} tools crafted, ${count('die').n} deaths, ${count('tame').n} animals tamed → ${out}`);
