// Simulation on a virtual clock: the world's time only advances when every due agent has acted,
// so hours of world pass in minutes. Scripted bots cost nothing; model agents cost what their turns cost.
//   node src/sim.ts [out.db] --bots 30 --hours 6 --seed 7
//   node src/sim.ts [out.db] --config sim.json --hours 3        (agents as in agents.json, plus "at")
// Watch the result: DATA_DIR=<dir of out.db> npm start   (the file must be named world.db)
import { mkdirSync, rmSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { World, rulesText, VERBS } from './world.ts';
import { initSandbox } from './sandbox.ts';
import { bot, PROVIDERS, intro, toolDefs, verbList, turnPrompt, SUMMARY_ASK } from './runner.ts';
import type { AgentConf, StepOut } from './runner.ts';

const args = process.argv.slice(2);
const opt = (k: string, d?: number) => { const i = args.indexOf('--' + k); return i >= 0 ? Number(args[i + 1]) : d; };
const sopt = (k: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const out = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'data/sim/world.db';
const hours = opt('hours', 6)!, seed = opt('seed', 7)!, step = 5000;
const conf = sopt('config') ? JSON.parse(readFileSync(sopt('config')!, 'utf8')) : { agents: [] };
const names = ['Wren', 'Pim', 'Oso', 'Tuk', 'Mira', 'Fen', 'Juno', 'Rue', 'Ivo', 'Sel', 'Aya', 'Bex', 'Cato', 'Dov', 'Esk', 'Fia', 'Gil', 'Hap', 'Ina', 'Jot', 'Kip', 'Lua', 'Mox', 'Nel', 'Ode', 'Pax', 'Quin', 'Ria', 'Sol', 'Tam'];
for (let i = 0; i < (opt('bots', conf.agents.length ? 0 : 30) ?? 0); i++) conf.agents.push({ name: names[i % 30] + (i >= 30 ? String(i) : ''), provider: 'bot', seed: i + 1 });

mkdirSync(dirname(out), { recursive: true }); for (const f of ['', '-wal', '-shm']) rmSync(out + f, { force: true });
const logFile = join(dirname(out), 'sim-log.txt'); writeFileSync(logFile, '');
await initSandbox();
let clock = Date.now() - hours * 3600_000;
const w = new World(out, { seed, ...(conf.world ?? {}) });
w.now = () => clock;
const verbs = Object.fromEntries(Object.entries(VERBS).map(([k, v]) => [k, { help: v.help, args: v.args }]));
const system = intro(rulesText(w.cfg)) + '\n\nVerbs:\n' + verbList(verbs), tools = toolDefs(verbs);
const t0 = clock, stamp = () => { const m = Math.round((clock - t0) / 60000); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const log = (s: string) => appendFileSync(logFile, `[${stamp()}] ${s}\n`);

type Body = { c: AgentConf; a: ReturnType<World['agents']['get']> & {}; think: (s: string, u: string, t: any[] | null) => Promise<StepOut>; next: number; bot: boolean; m: { summary: string; recent: string[]; steps: number }; tokens: number };
const bodies: Body[] = conf.agents.map((c: AgentConf & { at?: [number, number] }) => {
  const { id } = w.join(c.name, { provider: c.provider, model: c.model ?? null }, c.at);
  return { c, a: w.agents.get(id)!, think: (PROVIDERS as any)[c.provider](c), next: clock + Math.random() * 20_000, bot: c.provider === 'bot', m: { summary: '', recent: [], steps: 0 }, tokens: 0 };
});
const cap = conf.maxConcurrency ?? 6;

async function turn(b: Body) {
  const obs = w.act(b.a, 'look', { detail: b.c.detail ?? 1 }).text;
  if (b.a.state === 'left') { b.next = Infinity; return; }
  if (/^You are dead/.test(obs)) { b.next = clock + 60_000; return; }
  const user = b.bot ? `[Now]\n${obs}` : turnPrompt(b.a.notebook, b.m, obs);
  let r: StepOut;
  try { r = await b.think(system, user, b.bot ? null : tools); } catch (e: any) { log(`${b.c.name} provider error: ${e.message}`); b.next = clock + 120_000; return; }
  b.tokens += r.tokens;
  let rest = false;
  if (!r.calls.length && !b.bot) { b.m.recent.push(`(you chose not to act${r.text ? ': ' + r.text.slice(0, 150).replace(/\s+/g, ' ') : ''})`); rest = true; }
  for (const call of r.calls) {
    const res = w.act(b.a, call.verb, call.args);
    if (!b.bot) { const line = `> ${call.verb} ${JSON.stringify(call.args ?? {}).slice(0, 300)} → ${res.text.slice(0, 300)}`; b.m.recent.push(line); log(`${b.c.name} ${line.replace(/\n/g, ' ⏎ ')}`); }
    if ((res.data as any)?.rest) rest = true;
    if ((res.data as any)?.left) { b.next = Infinity; log(`${b.c.name} left the world`); return; }
  }
  if (!b.bot) {
    b.m.recent = b.m.recent.slice(-12); b.m.steps++;
    if (b.m.steps % 15 === 0) { try { const s = await b.think(system, user + SUMMARY_ASK, null); b.m.summary = s.text.trim().slice(0, 1500); b.tokens += s.tokens; log(`${b.c.name} summary: ${b.m.summary.replace(/\n/g, ' ')}`); } catch { /* keep the old one */ } }
  }
  const every = (b.c.interval ?? (b.bot ? 20 : 180)) * 1000;
  b.next = clock + (rest ? (b.c.restSec ?? (b.bot ? 120 : 600)) * 1000 : every * (0.9 + Math.random() * 0.2));
}

const end = clock + hours * 3600_000; let lastReport = clock;
// Every agent thinks independently. The clock moves on while calls are in flight, but never past the moment an
// in-flight agent was due to act again, so nobody falls behind; slow thinkers just see a world that moved a little.
const inflight = new Map<Body, { started: number; p: Promise<void> }>();
const period = (b: Body) => (b.c.interval ?? (b.bot ? 20 : 180)) * 1000;
while (clock < end) {
  for (const b of bodies) if (!inflight.has(b) && b.next <= clock) {
    const p = turn(b).finally(() => inflight.delete(b));
    inflight.set(b, { started: clock, p });
  }
  for (let i = 0; i < 3; i++) await Promise.resolve(); // let bots (which answer at once) finish
  const idle = bodies.filter(b => !inflight.has(b)), idleNext = Math.min(...idle.map(b => b.next));
  const limit = Math.min(...[...inflight].map(([b, f]) => f.started + period(b)));
  if (idleNext <= limit && idleNext < Infinity) clock = Math.min(end, Math.max(clock + (inflight.size ? 0 : 0), idleNext));
  else if (inflight.size) { await Promise.race([...inflight.values()].map(f => f.p)); if (limit < Infinity) clock = Math.min(end, Math.max(clock, Math.min(limit, idleNext))); }
  else clock = end;
  if (clock - lastReport >= 3600_000) { lastReport = clock; console.log(`${stamp()} world time · ${w.seq} events · ${w.blocks.size} blocks · tokens ${bodies.reduce((s, b) => s + b.tokens, 0).toFixed(0)}`); }
}
await Promise.all([...inflight.values()].map(f => f.p));
const count = (t: string) => (w.db.prepare('SELECT count(*) n FROM events WHERE type=?').get(t) as any).n;
console.log(`simulated ${hours}h with ${bodies.length} agents: ${w.seq} events, ${w.blocks.size} blocks, ${count('craft')} tools crafted, ${count('make')} artifacts, ${count('die')} deaths, ${count('tame')} tamed, ${bodies.reduce((s, b) => s + b.tokens, 0).toFixed(0)} tokens → ${out} (log: ${logFile})`);
