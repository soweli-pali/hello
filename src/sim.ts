// Simulation on a virtual clock: the world's time only advances when every due agent has acted,
// so hours of world pass in minutes. Scripted bots cost nothing; model agents cost what their turns cost.
//   node src/sim.ts [out.db] --bots 30 --hours 6 --seed 7
//   node src/sim.ts [out.db] --config sim.json --hours 3        (agents as in agents.json, plus "at", "planner")
//   options: --budget 40 (stop at this many dollars of model use)  --until 16:55 (stop at this UTC wall-clock time)
//            --resume (carry on an existing world: same bodies, their memories, the clock where it stopped)
// A file named STOP beside out.db also stops it cleanly. Watch the result: DATA_DIR=<dir of out.db> npm start
import { mkdirSync, rmSync, readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { World, rulesText, VERBS } from './world.ts';
import { initSandbox } from './sandbox.ts';
import { PROVIDERS, intro, toolDefs, verbList, turnPrompt, SUMMARY_ASK, PLAN_NOTE, planAsk } from './runner.ts';
import type { AgentConf, StepOut } from './runner.ts';

const args = process.argv.slice(2);
const opt = (k: string, d?: number) => { const i = args.indexOf('--' + k); return i >= 0 ? Number(args[i + 1]) : d; };
const sopt = (k: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const out = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'data/sim/world.db';
const speed = opt('speed', 0)!, hours = opt('hours', 6)!, seed = opt('seed', 7)!, budget = opt('budget', Infinity)!, resume = args.includes('--resume');
const until = sopt('until') ? (() => { const [h, m] = sopt('until')!.split(':').map(Number); const d = new Date(); d.setUTCHours(h, m, 0, 0); if (d.getTime() < Date.now()) d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); })() : Infinity;
const conf = sopt('config') ? JSON.parse(readFileSync(sopt('config')!, 'utf8')) : { agents: [] };
const names = ['Wren', 'Pim', 'Oso', 'Tuk', 'Mira', 'Fen', 'Juno', 'Rue', 'Ivo', 'Sel', 'Aya', 'Bex', 'Cato', 'Dov', 'Esk', 'Fia', 'Gil', 'Hap', 'Ina', 'Jot', 'Kip', 'Lua', 'Mox', 'Nel', 'Ode', 'Pax', 'Quin', 'Ria', 'Sol', 'Tam'];
for (let i = 0; i < (opt('bots', conf.agents.length ? 0 : 30) ?? 0); i++) conf.agents.push({ name: names[i % 30] + (i >= 30 ? String(i) : ''), provider: 'bot', seed: i + 1 });

const dir = dirname(out), logFile = join(dir, 'sim-log.txt'), memFile = join(dir, 'sim-mem.json'), stopFile = join(dir, 'STOP');
mkdirSync(dir, { recursive: true }); rmSync(stopFile, { force: true });
if (!resume) { for (const f of ['', '-wal', '-shm']) rmSync(out + f, { force: true }); writeFileSync(logFile, ''); }
await initSandbox();
let clock = Date.now() - hours * 3600_000;
const w = new World(out, { seed, ...(conf.world ?? {}) }, () => clock);
if (resume) clock = (w.db.prepare('SELECT max(t) t FROM events WHERE a IS NOT NULL').get() as any).t + 1000;
const verbs = Object.fromEntries(Object.entries(VERBS).map(([k, v]) => [k, { help: v.help, args: v.args }]));
const system = intro(rulesText(w.cfg)) + '\n\nVerbs:\n' + verbList(verbs), tools = toolDefs(verbs);
const saved = resume && existsSync(memFile) ? JSON.parse(readFileSync(memFile, 'utf8')) : { t0: clock, bodies: {} };
const t0 = saved.t0, stamp = () => { const m = Math.round((clock - t0) / 60000); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const log = (s: string) => appendFileSync(logFile, `[${stamp()}] ${s}\n`);

type Mem = { ms?: number; summary: string; recent: string[]; steps: number; plan: string; sincePlan: number; planning: boolean; tokens: number; cost: number };
type Body = { c: AgentConf; a: ReturnType<World['agents']['get']> & {}; think: (s: string, u: string, t: any[] | null) => Promise<StepOut>; plan?: (s: string, u: string, t: any[] | null) => Promise<StepOut>; next: number; bot: boolean; m: Mem };
const bodies: Body[] = conf.agents.map((c: AgentConf) => {
  const old = resume ? [...w.agents.values()].find(a => a.name === c.name && a.state !== 'left') : undefined;
  const a = old ?? w.agents.get(w.join(c.name, { provider: c.provider, model: c.model ?? null, planner: c.planner ?? undefined }, c.at).id)!;
  const m: Mem = { summary: '', recent: [], steps: 0, plan: '', sincePlan: 0, tokens: 0, cost: 0, ...(saved.bodies[c.name] ?? {}), planning: false };
  return { c, a, think: (PROVIDERS as any)[c.provider](c), plan: c.planner ? (PROVIDERS as any)[c.provider]({ ...c, model: c.planner, effort: c.plannerEffort ?? 'medium', maxTokens: 2000 }) : undefined, next: clock + Math.random() * 20_000, bot: c.provider === 'bot', m };
});
const cap = conf.maxConcurrency ?? 6;
const spent = () => bodies.reduce((s, b) => s + b.m.cost, 0), tokens = () => bodies.reduce((s, b) => s + b.m.tokens, 0);
const persist = () => writeFileSync(memFile, JSON.stringify({ t0, clock, bodies: Object.fromEntries(bodies.filter(b => !b.bot).map(b => [b.c.name, b.m])) }, null, 1));
const charge = (b: Body, r: StepOut) => { b.m.tokens += r.tokens; b.m.cost += r.cost ?? 0; };

// The slower mind: reads everything the quick one would, plus its current plan, and writes a summary and a new plan.
async function replan(b: Body, user: string, why: string) {
  if (!b.plan || b.m.planning) return; b.m.planning = true;
  try {
    const r = await b.plan(system + PLAN_NOTE, user + planAsk(b.c.planEvery ?? 10, b.m.plan), null); charge(b, r);
    const t = r.text.trim(), sm = /summary:\s*([\s\S]*?)(?=\n\s*\**plan:|$)/i.exec(t), pl = /plan:\s*([\s\S]*)$/i.exec(t);
    if (sm) b.m.summary = sm[1].replace(/\*+$/, '').trim().slice(0, 1200);
    b.m.plan = (pl ? pl[1] : t).trim().slice(0, 1800); b.m.sincePlan = 0;
    log(`${b.c.name} planned (${why}; ${((r.ms ?? 0) / 1000).toFixed(0)}s $${(r.cost ?? 0).toFixed(3)}): ${b.m.plan.replace(/\s+/g, ' ')}`);
  } catch (e: any) { log(`${b.c.name} planner error: ${e.message}`); } finally { b.m.planning = false; }
}

async function turn(b: Body) {
  const obs = w.act(b.a, 'look', { detail: b.c.detail ?? 1 }).text;
  if (b.a.state === 'left') { b.next = Infinity; return; }
  if (/^You are dead/.test(obs)) { b.next = clock + 60_000; b.m.sincePlan = 999; return; }
  const base = b.bot ? `[Now]\n${obs}` : turnPrompt(b.a.notebook, b.m, obs);
  if (b.plan && !b.m.plan) await replan(b, base, 'first'); // the very first plan is made before acting
  else if (b.plan && b.m.sincePlan >= (b.c.planEvery ?? 10)) void replan(b, base, b.m.sincePlan >= 999 ? 'woke' : 'routine'); // later ones while acting
  const user = b.plan && b.m.plan ? base.replace('[Now]', `[Your plan, from your deeper mind]\n${b.m.plan}\n\n[Now]`) : base;
  let r: StepOut;
  try { r = await b.think(system + (b.plan ? PLAN_NOTE : ''), user, b.bot ? null : tools); } catch (e: any) { log(`${b.c.name} provider error: ${e.message}`); if (/limit|quota|429/i.test(e.message)) limitHits++; b.next = clock + 120_000; return; }
  charge(b, r); limitHits = 0; b.m.ms = ((b.m.ms ?? 0) * 0.8 + (r.ms ?? 0) * 0.2);
  let rest = false;
  if (!r.calls.length && !b.bot) { b.m.recent.push(`(you chose not to act${r.text ? ': ' + r.text.slice(0, 150).replace(/\s+/g, ' ') : ''})`); rest = true; }
  for (const call of r.calls) {
    if (call.verb === 'replan') { if (b.plan) { b.m.recent.push(`> replan (${String(call.args?.why ?? '').slice(0, 120)})`); void replan(b, base, 'asked: ' + String(call.args?.why ?? '').slice(0, 80)); } continue; }
    const res = w.act(b.a, call.verb, call.args);
    if (!b.bot) { const line = `> ${call.verb} ${JSON.stringify(call.args ?? {}).slice(0, 300)} → ${res.text.slice(0, 300)}`; b.m.recent.push(line); log(`${b.c.name} ${line.replace(/\n/g, ' ⏎ ')}`); }
    if ((res.data as any)?.rest) rest = true;
    if ((res.data as any)?.left) { b.next = Infinity; log(`${b.c.name} left the world`); return; }
  }
  if (!b.bot) {
    b.m.recent = b.m.recent.slice(-12); b.m.steps++; b.m.sincePlan++;
    // the summary is written in the background, off the path of the agent's next turn (two-minded bodies get theirs from the planner)
    if (!b.plan && b.m.steps % 15 === 0) b.think(system, user + SUMMARY_ASK, null).then(s => { b.m.summary = s.text.trim().slice(0, 1500); charge(b, s); log(`${b.c.name} summary: ${b.m.summary.replace(/\n/g, ' ')}`); }).catch(() => { /* keep the old one */ });
  }
  const every = (b.c.interval ?? (b.bot ? 20 : 180)) * 1000;
  b.next = clock + (rest ? (b.c.restSec ?? (b.bot ? 120 : 600)) * 1000 : every * (0.9 + Math.random() * 0.2));
}

let limitHits = 0; // several usage-limit refusals in a row: stop rather than hammer the account
const end = clock + hours * 3600_000; let lastReport = clock, lastSave = Date.now(), why = `${hours}h done`;
// Every agent thinks independently. The clock moves on while calls are in flight, but never past the moment an
// in-flight agent was due to act again, so nobody falls behind; slow thinkers just see a world that moved a little.
const inflight = new Map<Body, { started: number; p: Promise<void> }>();
const period = (b: Body) => (b.c.interval ?? (b.bot ? 20 : 180)) * 1000;
const report = () => `${stamp()} world time · ${w.seq} events · ${w.blocks.size} blocks · ${w.roofs.size} roofs · tokens ${tokens().toFixed(0)} · $${spent().toFixed(2)} · ${new Date().toISOString().slice(11, 16)} UTC · slowest ${bodies.filter(b => b.m.ms).sort((a, b) => b.m.ms! - a.m.ms!).slice(0, 3).map(b => `${b.c.name} ${(b.m.ms! / 1000).toFixed(0)}s`).join(', ')}`;
// --speed N: the world runs at a steady N times real time instead, and each body acts when its thinking is done
// and its turn is due; slow thinkers simply act less often.
const startReal = Date.now(), startClock = clock;
while (speed && clock < end) {
  if (spent() >= budget) { why = `budget $${budget} reached`; break; }
  if (Date.now() >= until) { why = 'wall-clock stop time reached'; break; }
  if (existsSync(stopFile)) { why = 'STOP file'; break; }
  if (limitHits >= 4) { why = 'the model provider keeps refusing for usage limits'; break; }
  clock = Math.min(end, Math.max(clock, startClock + (Date.now() - startReal) * speed));
  for (const b of bodies) if (!inflight.has(b) && b.next <= clock && inflight.size < cap) {
    const p = turn(b).finally(() => inflight.delete(b));
    inflight.set(b, { started: clock, p });
  }
  await new Promise(r => setTimeout(r, 250));
  if (clock - lastReport >= 3600_000) { lastReport = clock; console.log(report()); }
  if (Date.now() - lastSave > 60_000) { lastSave = Date.now(); persist(); }
}
while (!speed && clock < end) {
  if (spent() >= budget) { why = `budget $${budget} reached`; break; }
  if (Date.now() >= until) { why = 'wall-clock stop time reached'; break; }
  if (existsSync(stopFile)) { why = 'STOP file'; break; }
  if (limitHits >= 4) { why = 'the model provider keeps refusing for usage limits'; break; }
  for (const b of bodies) if (!inflight.has(b) && b.next <= clock && inflight.size < cap + bodies.filter(x => x.bot).length) {
    const p = turn(b).finally(() => inflight.delete(b));
    inflight.set(b, { started: clock, p });
  }
  for (let i = 0; i < 3; i++) await Promise.resolve(); // let bots (which answer at once) finish
  const idle = bodies.filter(b => !inflight.has(b)), idleNext = Math.min(...idle.map(b => b.next));
  const limit = Math.min(...[...inflight].map(([b, f]) => f.started + period(b)));
  if (inflight.size && idle.some(b => b.next <= clock)) await Promise.race([...inflight.values()].map(f => f.p)); // waiting for a free slot
  else if (idleNext <= limit && idleNext < Infinity) clock = Math.min(end, Math.max(clock, idleNext));
  else if (inflight.size) { await Promise.race([...inflight.values()].map(f => f.p)); if (limit < Infinity) clock = Math.min(end, Math.max(clock, Math.min(limit, idleNext))); }
  else if (idleNext >= Infinity) clock = end;
  if (clock - lastReport >= 3600_000) { lastReport = clock; console.log(report()); }
  if (Date.now() - lastSave > 60_000) { lastSave = Date.now(); persist(); }
}
log(`stopping: ${why}; waiting for turns in flight`);
await Promise.all([...inflight.values()].map(f => f.p));
persist();
const count = (t: string) => (w.db.prepare('SELECT count(*) n FROM events WHERE type=?').get(t) as any).n;
console.log(`stopped (${why}) at ${report()}\n${bodies.length} agents: ${w.seq} events, ${count('craft')} tools crafted, ${count('make')} artifacts, ${count('die')} deaths, ${count('tame')} tamed → ${out} (log: ${logFile})`);
process.exit(0);
