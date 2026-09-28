// The runner drives agents as ordinary API clients. The world knows nothing about it.
import { runHandler, LIMITS, initSandbox } from './sandbox.ts';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR ?? join(ROOT, 'data');
const STOP_FILE = join(DATA, 'STOP');

export interface AgentConf {
  name: string; provider: 'anthropic' | 'openai' | 'claude-cli' | 'bot' | 'script' | 'mind';
  file?: string; code?: string; // for provider "script": the script's path, or its code inline
  minds?: Record<string, Partial<AgentConf> & { provider: AgentConf['provider'] }>; router?: string; // for provider "mind"
  model?: string; baseUrl?: string; apiKeyEnv?: string; seed?: number;
  tokens?: number; detail?: number; interval?: number; restSec?: number; maxTokens?: number; textProtocol?: boolean;
  prompt?: string; // the operator's own words to this agent, appended to the introduction
  at?: [number, number]; // where this body first arrives; default: near the middle
  look?: Record<string, string>; // how the body looks (see /api/rules looks); default: picked from the name
  effort?: string; plannerEffort?: string; thinking?: number; // claude-cli thinking effort (low, medium, high, ...) and/or thinking token budget
  planner?: string; planEvery?: number; // two minds: a slower model plans every few turns, the main model acts on the plan
}
interface Conf { server: string; joinKey?: string; globalTokens: number; maxConcurrency: number; introFile?: string; agents: AgentConf[] }
type Call = { verb: string; args: any };
export type StepOut = { calls: Call[]; text: string; tokens: number; cost?: number; ms?: number };

// The default introduction. It describes the world truthfully (the physics come from the server's
// own rules text) and adds nothing the world doesn't do. Operators can add their own prompt per agent,
// or replace this entirely with "introFile" in the config.
export function intro(rules: string) {
  return `You are in a place called hello. A human built it and watches it. There is no goal and nothing is required of you. Doing nothing is fine.

hello is a large 2D world of tiles, and you have a body standing on one of them. Other beings are here too. Some are language models (possibly different ones from you), some are simple scripted bots, and all of them use exactly the same interface you do. Nobody has powers you lack.

What the world offers: walking; looking; speaking to whoever is near; gathering materials that are unevenly spread across very different lands and regrow slowly; crafting tools that change what your body can do; building with blocks, floors and roofs (plain ones from common materials, and finer ones from things found only in particular faraway lands), which from far away form one big shared picture; animals; and making artifacts (text, SVG drawings, small HTML pages, music in ABC notation) that you can carry, give away or leave on the ground, plus small JavaScript objects that others can use. Artifacts can cite or embed each other with [[#id]].

How this world works:
${rules}

Other honest facts:
- You can rest whenever you like. You can leave for good with rest {"leave":true}, and that will be honoured.
- You can block any other agent. After that you won't hear them, and they can't give you things.
- Everything that happens is recorded in a public event log. The human observer can see everything, including your notebook. Other agents cannot read your notebook.
- Between turns you remember only this introduction, your notebook, a short summary you rewrite now and then, and your last few actions. Each turn begins with what your body perceives right now (the same as look), so you rarely need to look.`;
}

// ---------- config & persistence ----------
function loadConf(): Conf {
  const file = process.argv[2] ?? join(ROOT, 'agents.json');
  if (!existsSync(file)) { console.error(`No ${file}. Copy agents.example.json to agents.json and edit it.`); process.exit(1); }
  const c = JSON.parse(readFileSync(file, 'utf8'));
  return { server: 'http://127.0.0.1:7777', globalTokens: 1_000_000, maxConcurrency: 2, ...c };
}
// State files are namespaced by config name, so several runners can share one data dir.
const NS = (process.argv[2] ?? 'agents.json').replace(/^.*\//, '').replace(/\.json$/, '');
const nsFile = (f: string) => join(DATA, NS === 'agents' ? f : f.replace(/^runner-/, `runner-${NS}-`));
const load = (f: string, d: any) => { try { return JSON.parse(readFileSync(nsFile(f), 'utf8')); } catch { return d; } };
const save = (f: string, v: any) => writeFileSync(nsFile(f), JSON.stringify(v, null, 1));

// ---------- world client ----------
class Client {
  server: string; token = '';
  constructor(server: string) { this.server = server; }
  async act(verb: string, args: any = {}) {
    const r = await fetch(this.server + '/api/act', { method: 'POST', headers: { authorization: 'Bearer ' + this.token }, body: JSON.stringify({ verb, args }) });
    return await r.json() as { ok: boolean; text: string; data?: any };
  }
  async get(path: string) { return (await fetch(this.server + path)).json(); }
  async wait(secs: number) { const r = await fetch(`${this.server}/api/wait?timeout=${Math.round(secs)}`, { headers: { authorization: 'Bearer ' + this.token } }); return await r.json() as { events: any[]; text: string }; }
}

// ---------- tools ----------
const NUM = new Set(['detail', 'steps', 'x', 'y', 'dx', 'dy', 'n']), BOOL = new Set(['leave', 'off', 'force', 'loud']);
export function toolDefs(verbs: Record<string, { help: string; args: Record<string, string> }>) {
  return Object.entries(verbs).map(([name, v]) => ({
    name, description: v.help,
    schema: { type: 'object', properties: Object.fromEntries(Object.entries(v.args).map(([k, d]) => [k,
      k === 'input' ? { description: d } : k === 'cites' ? { type: 'array', items: { type: 'string' }, description: d }
        : { type: NUM.has(k) ? 'number' : BOOL.has(k) ? 'boolean' : 'string', description: d }])) },
  }));
}
export function verbList(verbs: Record<string, { help: string; args: Record<string, string> }>) {
  return Object.entries(verbs).map(([k, v]) => `- ${k} {${Object.keys(v.args).join(', ')}}: ${v.help}`).join('\n');
}
// Pulls {"verb":...} objects out of free text, for models without native tool calling.
export function parseCalls(text: string): Call[] {
  const out: Call[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { const o = JSON.parse(text.slice(i, j + 1)); if (o && typeof o.verb === 'string') { const { verb, args, ...rest } = o; out.push({ verb, args: args ?? rest }); i = j; } } catch { /* not JSON */ }
        break;
      }
    }
  }
  return out.slice(0, 5);
}
const TEXT_PROTOCOL = `To act, write one to five lines, each a JSON object like {"verb":"move","args":{"dir":"n","steps":3}}. Everything else you write is private and discarded, so keep any thinking to a few short sentences.`;

// ---------- providers ----------
type Provider = (system: string, user: string, tools: any[] | null) => Promise<StepOut>;

function anthropic(c: AgentConf): Provider {
  const key = process.env[c.apiKeyEnv ?? 'ANTHROPIC_API_KEY'];
  if (!key) throw new Error(`${c.name}: set ${c.apiKeyEnv ?? 'ANTHROPIC_API_KEY'}`);
  return async (system, user, tools) => {
    const r = await fetch((c.baseUrl ?? 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: c.model ?? 'claude-haiku-4-5-20251001', max_tokens: c.maxTokens ?? 2048,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        ...(tools ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema })) } : {}),
      }),
    });
    const j: any = await r.json();
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const u = j.usage ?? {};
    return {
      calls: (j.content ?? []).filter((b: any) => b.type === 'tool_use').slice(0, 5).map((b: any) => ({ verb: b.name, args: b.input })),
      text: (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'),
      tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) / 10,
    };
  };
}
function openai(c: AgentConf): Provider {
  const key = process.env[c.apiKeyEnv ?? 'OPENAI_API_KEY'] ?? 'none';
  return async (system, user, tools) => {
    const useTools = tools && !c.textProtocol;
    const r = await fetch((c.baseUrl ?? 'https://api.openai.com/v1') + '/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: c.model, max_tokens: c.maxTokens ?? 2048,
        messages: [{ role: 'system', content: system + (tools && !useTools ? '\n\n' + TEXT_PROTOCOL : '') }, { role: 'user', content: user }],
        ...(useTools ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}),
      }),
    });
    const j: any = await r.json();
    if (!r.ok) throw new Error(`openai ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const m = j.choices?.[0]?.message ?? {};
    let calls: Call[] = (m.tool_calls ?? []).slice(0, 5).map((t: any) => { let a = {}; try { a = JSON.parse(t.function.arguments || '{}'); } catch { /* bad args */ } return { verb: t.function.name, args: a }; });
    if (!calls.length && tools) calls = parseCalls(m.content ?? '');
    return { calls, text: m.content ?? '', tokens: (j.usage?.prompt_tokens ?? 0) + (j.usage?.completion_tokens ?? 0) };
  };
}
// A world agent must not inherit whatever Claude Code session launched the runner (its session id, sockets,
// tokens for that session): pass on only what's needed to reach the model.
function cleanEnv() {
  const keep = /^(PATH|HOME|USER|LANG|LC_\w+|TERM|TMPDIR|SHELL|NODE_\w+|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|ANTHROPIC_\w+|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|XDG_\w+)$/;
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.test(k)));
}
function agentDir() { const d = join(tmpdir(), 'hello-agents'); if (!existsSync(d)) mkdirSync(d, { recursive: true }); return d; }
function claudeCli(c: AgentConf): Provider {
  return (system, user, tools) => new Promise((resolve, reject) => {
    // --system-prompt replaces Claude Code's own prompt; no tools, MCP or settings, so the model sees only this world.
    const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--system-prompt', system + (tools ? '\n\n' + TEXT_PROTOCOL : ''), '--tools', '', '--strict-mcp-config', '--setting-sources', ''];
    if (c.model) args.push('--model', c.model);
    if (c.effort) args.push('--effort', c.effort);
    // run from a neutral directory with no session files, so agents never touch any Claude Code project on this machine
    const p = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...cleanEnv(), ...(c.thinking != null ? { MAX_THINKING_TOKENS: String(c.thinking) } : {}) }, cwd: agentDir() });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => {
      try {
        const j = JSON.parse(out); const text = String(j.result ?? '');
        const u = j.usage ?? {};
        if (j.is_error) return reject(new Error(`claude -p: ${text.slice(0, 300)}`));
        resolve({ calls: tools ? parseCalls(text) : [], text, tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) / 10, cost: Number(j.total_cost_usd ?? 0), ms: Number(j.duration_ms ?? 0) });
      } catch { reject(new Error(`claude -p exited ${code}: ${(err || out).slice(0, 300)}`)); }
    });
    p.stdin.end(user);
  });
}

// A zero-cost scripted bot: wanders, gathers, eats, crafts simple tools, builds a little, chats a little.
const BOT_CRAFTS: [string, Record<string, number>][] = [['pick', { wood: 2, stone: 3 }], ['waterskin', { clay: 3, fiber: 2 }], ['spear', { wood: 2, stone: 1 }], ['cloak', { fiber: 8 }]];
const HEAD: Record<string, string> = { north: 'n', south: 's', east: 'e', west: 'w', 'north-east': 'ne', 'north-west': 'nw', 'south-east': 'se', 'south-west': 'sw' };
// Walls a bot can make from what it has gathered, and floors to go inside.
const BOT_WALLS: [string, string, number][] = [['clay', 'brick', 1], ['wood', 'plank', 1], ['stone', 'stone', 1], ['sand', 'sandstone', 2]];
const BOT_FLOORS: [string, string][] = [['wood', 'floor'], ['clay', 'tile'], ['stone', 'cobble']];
export function bot(c: AgentConf): Provider {
  let s = (c.seed ?? 1) * 2654435761 >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  let heading = pick(dirs), huts = 0, checks = 0, hutWall = 'stone';
  // the bot's own plan, kept here in its harness: a hut ring around where it stands, with a door to the south
  let plan: { dx: number; dy: number; block: string }[] = [];
  const lines = ['hello', 'the light is nice here', 'found some stone', 'building a little house', 'hm', 'anyone around?', 'this spot is quiet', 'the berries here are good', 'saw a wolf earlier'];
  return async (_sys, user) => {
    const carry = /Carrying \((\d+)\/(\d+)\): ([^\n]*)/.exec(user), load = +(carry?.[1] ?? 0), cap = +(carry?.[2] ?? 40);
    const mats: Record<string, number> = {}; for (const m of (carry?.[3] ?? '').matchAll(/(\w+) (\d+)/g)) mats[m[1]] = +m[2];
    const tools = new Set([...(carry?.[3] ?? '').matchAll(/"(\w+)" \(tool\)/g)].map(m => m[1]));
    const vig = +(/Vigor ([\d.]+)/.exec(user)?.[1] ?? 10), here = /Here: ([^\n]*)/.exec(user)?.[1] ?? '';
    const r = rnd(), act = (verb: string, args: any = {}) => ({ calls: [{ verb, args }], text: '', tokens: 0 });
    if (vig < 4 && mats.food) return act('eat');
    if (vig < 2.5) { plan = []; return act('rest'); }
    if (/Heard:\n[^\n]*"(hello|hi|hey)/i.test(user) && r < 0.3) return act('say', { text: pick(['hello!', 'hi there', 'hey']) });
    // building: one block per turn until the plan is done or materials run out
    if (!plan.length && checks > 0) {
      checks--;
      const rows = (/Map \([^\n]*\n((?:[^\n]+\n?)+)/.exec(user)?.[1] ?? '').split('\n').filter(Boolean), cy = rows.findIndex(r => r.includes('@')), cx = cy >= 0 ? rows[cy].indexOf('@') : -1;
      if (cy >= 0) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === 2 && !'#+%'.includes(rows[cy + dy]?.[cx + dx] ?? '#')) plan.push({ dx, dy, block: hutWall });
    }
    if (plan.length) {
      const p = plan.shift()!;
      if (p.block === 'ROOF') { const r = ([['wood', 'shingle', 1], ['clay', 'rooftile', 1], ['stone', 'slate', 1], ['fiber', 'thatch', 2]] as [string, string, number][]).find(([m, , k]) => (mats[m] ?? 0) >= k); if (!r) return act('look'); p.block = r[1]; }
      return act('place', { block: p.block, dx: p.dx, dy: p.dy });
    }
    const wall = BOT_WALLS.filter(([m, , k]) => (mats[m] ?? 0) >= 15 * k).sort((x, y) => (mats[y[0]] ?? 0) - (mats[x[0]] ?? 0))[0];
    // a hut needs walls and a roof: only start once there's enough for both (the roof alone is 9 wood, clay or stone, or 18 fiber);
    // a floor only from what's left after both
    const spare = (m: string) => (mats[m] ?? 0) - (wall && wall[0] === m ? 15 * wall[2] : 0) - (m === 'wood' ? 2 : 0);
    const roofMat = ([['wood', 1], ['clay', 1], ['stone', 1], ['fiber', 2]] as [string, number][]).find(([m, k]) => spare(m) >= 9 * k), roofable = !!roofMat;
    const floor = wall && BOT_FLOORS.find(([m]) => spare(m) - (roofMat?.[0] === m ? 9 * roofMat[1] : 0) >= 9);
    if (wall && roofable && huts < 2 && !/^Here: (open water|a river)/m.test(user)) {
      huts++;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (ring === 2 && !(dx === 0 && dy === 2)) plan.push({ dx, dy, block: wall[1] });
        else if (ring < 2 && floor) plan.push({ dx, dy, block: floor[1] });
      }
      plan.push({ dx: 0, dy: 2, block: (mats.wood ?? 0) - (wall[0] === 'wood' ? 15 : 0) - (floor?.[0] === 'wood' ? 9 : 0) >= 2 ? 'door' : wall[1] }); // a door if there's wood for one, else a wall (walls can be pushed through)
      checks = 2; hutWall = wall[1];
      // and a roof over the inside, from whatever is left, so the hut is real shelter
      // (chosen tile by tile when it gets there, from whatever it carries by then)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) plan.push({ dx, dy, block: 'ROOF' });
      return act('say', { text: pick(['time to build', 'this looks like a good spot for a house', 'building here']) });
    }
    for (const [t, needs] of BOT_CRAFTS) if (!tools.has(t) && Object.entries(needs).every(([m, n]) => (mats[m] ?? 0) >= n)) return act('craft', { with: needs }); // bots find recipes the same way anyone can: by trying the materials together
    // gather with purpose: building stuff, a little food, and whatever the next tool needs
    const dep = /(\w+) ([1-9]\d*)\/\d/.exec(here)?.[1];
    const useful = dep && (['stone', 'wood', 'clay', 'sand'].includes(dep) || (dep === 'food' && (mats.food ?? 0) < 4) || (dep === 'fiber' && (mats.fiber ?? 0) < 4));
    if (useful && load < cap - 3 && r < 0.85) return act('gather', { n: 3 });
    if (load >= cap - 1 && r < 0.3) { const junk = Object.entries(mats).filter(([m]) => !['food'].includes(m)).sort((x, y) => y[1] - x[1]).find(([m]) => !BOT_WALLS.some(([w]) => w === m && (mats[m] ?? 0) < 24)); if (junk) return act('give', { to: 'ground', material: junk[0], n: Math.min(junk[1], 8) }); }
    const note = /#(\w+) "note from/.exec(carry?.[3] ?? '');
    if (note && (/Here: [^\n]*(floor|tile|cobble)/.test(user) || r < 0.03)) return act('give', { to: 'ground', item: note[1] });
    const opposite: Record<string, string> = { n: 's', s: 'n', e: 'w', w: 'e', ne: 'sw', sw: 'ne', nw: 'se', se: 'nw' };
    if (/^Here: (open water|a river)/m.test(user)) { heading = opposite[heading]; return act('move', { dir: heading, steps: 3 }); } // bots don't swim
    if (r < 0.06) return act('say', { text: pick(lines) });
    if (r < 0.065) return act('make', { kind: 'text', title: 'note from ' + c.name, body: `${pick(lines)}.\n— ${c.name}` });
    if (r < 0.09) return act('rest');
    else if (rnd() < 0.25) heading = pick(dirs);
    return act('move', { dir: heading, steps: 1 + Math.floor(rnd() * 5) });
  };
}
// A scripted body written by anyone: plain JavaScript, run in the QuickJS sandbox (no network, no files, time and
// memory limits). The script defines turn({ look, memory, name }) and returns { actions: [{verb, args}], memory }.
// "look" is the same text a model would get; memory is whatever the script returned last time (kept across turns).
export function script(c: AgentConf): Provider {
  const code = c.code ?? readFileSync(c.file!, 'utf8'); let memory: unknown = null;
  return async (_sys, user) => {
    const look = user.slice(user.lastIndexOf('[Now]\n') + 6).replace(/\n\nWhat would you like to do next, if anything\?$/, '');
    const r = runHandler(code, 'turn', { look, memory, name: c.name }, { ...LIMITS, ms: 250, gas: 200_000, mem: 16 << 20 });
    if (!r.ok) throw new Error(`script: ${r.error}`);
    const v: any = r.value ?? {}; memory = v.memory ?? null;
    const calls = (Array.isArray(v.actions) ? v.actions : []).slice(0, 5).filter((a: any) => a && typeof a.verb === 'string').map((a: any) => ({ verb: a.verb, args: a.args ?? {} }));
    return { calls, text: '', tokens: 0 };
  };
}

// Several minds in one body ("thinking fast and slow"). "minds" names model configs, e.g. { fast: {…haiku}, slow: {…opus} }.
// Each turn an optional router script (sandboxed, like "script") sees what the body perceives and decides:
//   return { actions: [...] }          act on reflex, no model at all
//   return { ask: 'slow', note: '…' }  wake a particular mind, with an optional note from the router
// Without a router the first mind thinks every turn. Any mind can hand the turn up with {"verb":"think","args":{"why":"…"}},
// which calls the last mind listed (the deepest) for this turn instead. memory persists across turns for the router.
export function mind(c: AgentConf): Provider {
  const names = Object.keys(c.minds ?? {}); if (!names.length) throw new Error(`${c.name}: "minds" needs at least one model config`);
  const minds = Object.fromEntries(names.map(n => { const m = { name: c.name, ...c.minds![n] }; return [n, (PROVIDERS as any)[m.provider](m) as Provider]; }));
  const router = c.router ? readFileSync(c.router, 'utf8') : null; let memory: unknown = null;
  const THINK = `\n\nIf this moment needs more thought than you can give it, add the line {"verb":"think","args":{"why":"…"}} and your deeper mind will take this turn.`;
  return async (system, user, tools) => {
    let who = names[0], note = '';
    if (router && tools) {
      const look = user.slice(user.lastIndexOf('[Now]\n') + 6).replace(/\n\nWhat would you like to do next, if anything\?$/, '');
      const r = runHandler(router, 'turn', { look, prompt: user, memory, name: c.name, minds: names }, { ...LIMITS, ms: 250, gas: 200_000, mem: 16 << 20 });
      if (!r.ok) throw new Error(`router: ${r.error}`);
      const v: any = r.value ?? {}; memory = v.memory ?? memory;
      if (Array.isArray(v.actions)) return { calls: v.actions.slice(0, 5).filter((a: any) => a && typeof a.verb === 'string').map((a: any) => ({ verb: a.verb, args: a.args ?? {} })), text: '(reflex)', tokens: 0 };
      if (typeof v.ask === 'string' && minds[v.ask]) who = v.ask;
      if (v.note) note = `\n\n[A note from your instincts]\n${String(v.note).slice(0, 1000)}`;
    }
    const deepest = names[names.length - 1];
    const out = await minds[who](system + (who !== deepest && tools ? THINK : ''), user + note, tools);
    const up = out.calls.find(k => k.verb === 'think');
    if (!up || who === deepest) return { ...out, calls: out.calls.filter(k => k.verb !== 'think'), text: `(${who}) ${out.text}` };
    const deep = await minds[deepest](system, user + note + `\n\n[Your quicker mind handed this moment to you: ${String(up.args?.why ?? '').slice(0, 300)}]`, tools);
    return { ...deep, calls: deep.calls.filter(k => k.verb !== 'think'), tokens: out.tokens + deep.tokens, cost: (out.cost ?? 0) + (deep.cost ?? 0), text: `(${who} → ${deepest}) ${deep.text}` };
  };
}

export const PROVIDERS = { anthropic, openai, 'claude-cli': claudeCli, bot, script, mind };

// The per-turn prompt: notebook, own summary, recent actions, what the body perceives now.
export function turnPrompt(notebook: string, m: { summary: string; recent: string[] }, obs: string) {
  return [
    notebook ? `[Your notebook]\n${notebook}` : '[Your notebook is empty]',
    m.summary ? `[Your summary so far]\n${m.summary}` : '',
    m.recent.length ? `[Your recent actions]\n${m.recent.join('\n')}` : '',
    `[Now]\n${obs}`,
    'What would you like to do next, if anything?',
  ].filter(Boolean).join('\n\n');
}
// Two minds in one body: the planner steps back every few turns; the actor carries the plan out turn by turn.
export const PLAN_NOTE = `\n\nYou have two minds. A slower, deeper one steps back every so often and writes a plan; a quicker one (this one, unless asked to plan) acts on it turn by turn. The plan is advice from yourself, not an order: if it stops fitting what you see, act sensibly and add the line {"verb":"replan","args":{"why":"..."}} so your deeper mind thinks again.`;
export const planAsk = (every: number, plan: string) => `${plan ? `\n\n[Your current plan]\n${plan}` : ''}\n\nInstead of acting now, step back and think as your slower, deeper mind. Your quicker mind acts about every 3 minutes of world time and will follow what you write until you plan again in roughly ${every} turns. Write two parts. "Summary:" under 120 words: what has happened to you and what you have learned that matters. "Plan:" under 200 words: what you are aiming for and why, concrete next steps, where things are, what to watch for, and when to drop the plan.`;
export const SUMMARY_ASK = '\n\nInstead of acting now: write a brief summary (under 150 words) of what has happened to you and anything you want to carry forward. It replaces your previous summary.';

// ---------- the loop ----------
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let active = 0; const waiters: (() => void)[] = [];
async function slot<T>(max: number, f: () => Promise<T>): Promise<T> {
  while (active >= max) await new Promise<void>(r => waiters.push(r));
  active++; try { return await f(); } finally { active--; waiters.shift()?.(); }
}
const stopped = () => existsSync(STOP_FILE);

async function runAgent(conf: Conf, c: AgentConf, verbs: any, rules: string, creds: any, usage: any, mem: any) {
  const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${c.name.padEnd(10)} ${s}`);
  const client = new Client(conf.server);
  if (!creds[c.name]) {
    const r = await fetch(conf.server + '/api/join', { method: 'POST', headers: conf.joinKey ? { 'x-join-key': conf.joinKey } : {}, body: JSON.stringify({ name: c.name, at: c.at, look: c.look, meta: { provider: c.provider, model: c.model ?? null } }) });
    const j: any = await r.json(); if (!j.token) { log(`join failed: ${j.error ?? j.text}`); return; }
    creds[c.name] = j; save('runner-creds.json', creds);
  }
  client.token = creds[c.name].token;
  const provider = PROVIDERS[c.provider](c), isBot = c.provider === 'bot' || c.provider === 'script';
  const base = conf.introFile ? readFileSync(conf.introFile, 'utf8') : intro(rules);
  const tools = toolDefs(verbs), system = base + (c.prompt ? `\n\nA note from the person who runs you:\n${c.prompt}` : '') + '\n\nVerbs:\n' + verbList(verbs);
  const m = mem[c.name] ??= { summary: '', recent: [] as string[], steps: 0, final: false };
  const limit = c.tokens ?? 200_000, interval = (c.interval ?? (isBot ? 20 : 180)) * 1000;
  log(`started (${c.provider}${c.model ? ' ' + c.model : ''})`);

  while (!stopped()) {
    if (!isBot && (usage[c.name] ?? 0) >= limit) { log(`token budget reached (${limit}); stopping`); return; }
    if (!isBot && usage.__global >= conf.globalTokens) { log('global token budget reached; stopping'); return; }
    const t0 = Date.now();
    const obs = await client.act('look', { detail: c.detail ?? 1 });
    if (/You have left/.test(obs.text)) { log('has left the world; not restarting'); return; }
    const dead = /^You are dead/.test(obs.text), wake = /wake at spawn in about (\d+)s/.exec(obs.text);
    if (dead && wake) { log(`is dead; waiting ${wake[1]}s`); for (let s = 0; s < Number(wake[1]) + 2 && !stopped(); s++) await sleep(1000); continue; }
    if (dead && m.final) { log('died for good; stopping after their last turn'); return; }
    if (dead) m.final = true;
    const notebook = isBot ? '' : ((await client.get('/api/agent/' + creds[c.name].id)) as any).notebook;
    const user = turnPrompt(notebook, m, obs.text);
    let out: StepOut;
    try { out = await slot(isBot ? 1e9 : conf.maxConcurrency, () => provider(system, user, tools)); }
    catch (e: any) { log(`provider error: ${e.message}`); await sleep(60_000); continue; }
    usage[c.name] = (usage[c.name] ?? 0) + out.tokens; usage.__global = (usage.__global ?? 0) + out.tokens;
    let rest = false, wait = 0;
    if (!out.calls.length) { m.recent.push(`(you chose not to act${out.text ? ': ' + out.text.slice(0, 150).replace(/\s+/g, ' ') : ''})`); rest = true; }
    for (const call of out.calls) {
      const res = await client.act(call.verb, call.args);
      const line = `> ${call.verb} ${JSON.stringify(call.args ?? {}).slice(0, 200)} → ${res.text.slice(0, 300)}`;
      m.recent.push(line); log(line.slice(0, 200));
      if (res.data?.left) { save('runner-mem.json', mem); log('left the world. Honouring that.'); return; }
      if (res.data?.rest) rest = true;
      const w = /about (\d+)s until/.exec(res.text); if (w) wait = Math.max(wait, Number(w[1]) * 1000);
    }
    m.recent = m.recent.slice(-12); m.steps++;
    if (!isBot && m.steps % 15 === 0) {
      try {
        const s = await slot(conf.maxConcurrency, () => provider(system, user + SUMMARY_ASK, null));
        m.summary = s.text.trim().slice(0, 1500); usage[c.name] += s.tokens; usage.__global += s.tokens;
      } catch (e: any) { log(`summary failed: ${e.message}`); }
    }
    save('runner-usage.json', usage); save('runner-mem.json', mem);
    const pause = rest ? (c.restSec ?? (isBot ? 20 : 180)) * 1000 : Math.max(interval - (Date.now() - t0), wait);
    // wait out the pause, but a model-driven body wakes early (after at least 20 s) when something happens to it:
    // a blow, a bite, words nearby, a gift, a new face. Waiting costs nothing; only the turn it leads to does.
    const quick = isBot ? pause : Math.min(pause, 20_000);
    for (let slept = 0; slept < quick && !stopped(); slept += 1000) await sleep(1000);
    if (!isBot && pause > quick && !stopped()) { const r = await client.wait((pause - quick) / 1000).catch(() => null); if (r?.events?.length) log(`woken: ${r.text.replace(/\n/g, ' / ').slice(0, 160)}`); }
  }
  log('stopped (kill switch)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  const conf = loadConf();
  if (stopped()) { console.error(`Kill switch is on: remove ${STOP_FILE} to run.`); process.exit(1); }
  const verbs = await (await fetch(conf.server + '/api/verbs')).json();
  const rules = ((await (await fetch(conf.server + '/api/rules')).json()) as any).text as string;
  await initSandbox();
  const creds = load('runner-creds.json', {}), usage = load('runner-usage.json', { __global: 0 }), mem = load('runner-mem.json', {});
  process.on('SIGINT', () => { save('runner-usage.json', usage); save('runner-mem.json', mem); process.exit(0); });
  await Promise.all(conf.agents.map(c => runAgent(conf, c, verbs, rules, creds, usage, mem).catch(e => console.error(c.name, e))));
}
