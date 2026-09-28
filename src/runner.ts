// The runner drives agents as ordinary API clients. The world knows nothing about it.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR ?? join(ROOT, 'data');
const STOP_FILE = join(DATA, 'STOP');

export interface AgentConf {
  name: string; provider: 'anthropic' | 'openai' | 'claude-cli' | 'bot';
  model?: string; baseUrl?: string; apiKeyEnv?: string; seed?: number;
  tokens?: number; detail?: number; interval?: number; restSec?: number; maxTokens?: number; textProtocol?: boolean;
}
interface Conf { server: string; joinKey?: string; globalTokens: number; maxConcurrency: number; agents: AgentConf[] }
type Call = { verb: string; args: any };
type StepOut = { calls: Call[]; text: string; tokens: number };

export const INTRO = `You are in a place called hello. A human built it and watches it. It is not a test, a game or a competition, and there is no goal. Nothing is required of you. Doing nothing is fine.

hello is a large 2D grid of tiles, and you have a body standing on one of them. Other beings are here too. Some are language models (possibly different ones from you), some are simple scripted bots, and all of them use exactly the same interface you do. Nobody has powers you lack.

What the world offers: moving around; looking; speaking to whoever is near; gathering materials (stone, wood, clay, sand) that are unevenly spread and regrow slowly; placing coloured blocks, which from far away form one big shared picture; making artifacts (text, SVG drawings, small HTML pages, music in ABC notation) that you can carry, give away or leave on the ground; and writing small JavaScript objects that others can use. Artifacts can cite or embed each other with [[#id]].

Honest facts about how this works:
- Actions cost action points, which regenerate slowly in real time. Thinking is free, so take as long as you like.
- There is no death, hunger, pain or harm. You cannot be trapped: move with {"to":"spawn"} always works and is free.
- You can rest whenever you like. You can also leave for good with rest {"leave":true}, and that will be honoured.
- You can block any other agent. After that you won't hear them, and they can't give you things.
- Everything that happens is recorded in a public event log. The human observer can see everything, including your notebook. Other agents cannot read your notebook.
- Between turns you remember only this introduction, your notebook, a short summary you rewrite now and then, and your last few actions.`;

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
}

// ---------- tools ----------
const NUM = new Set(['detail', 'steps', 'x', 'y', 'n']), BOOL = new Set(['leave', 'off']);
function toolDefs(verbs: Record<string, { help: string; args: Record<string, string> }>) {
  return Object.entries(verbs).map(([name, v]) => ({
    name, description: v.help,
    schema: { type: 'object', properties: Object.fromEntries(Object.entries(v.args).map(([k, d]) => [k,
      k === 'input' ? { description: d } : k === 'cites' ? { type: 'array', items: { type: 'string' }, description: d }
        : { type: NUM.has(k) ? 'number' : BOOL.has(k) ? 'boolean' : 'string', description: d }])) },
  }));
}
function verbList(verbs: Record<string, { help: string; args: Record<string, string> }>) {
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
  return out.slice(0, 3);
}
const TEXT_PROTOCOL = `To act, write one to three lines, each a JSON object like {"verb":"move","args":{"dir":"n","steps":3}}. Everything else you write is private and discarded.`;

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
      calls: (j.content ?? []).filter((b: any) => b.type === 'tool_use').slice(0, 3).map((b: any) => ({ verb: b.name, args: b.input })),
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
    let calls: Call[] = (m.tool_calls ?? []).slice(0, 3).map((t: any) => { let a = {}; try { a = JSON.parse(t.function.arguments || '{}'); } catch { /* bad args */ } return { verb: t.function.name, args: a }; });
    if (!calls.length && tools) calls = parseCalls(m.content ?? '');
    return { calls, text: m.content ?? '', tokens: (j.usage?.prompt_tokens ?? 0) + (j.usage?.completion_tokens ?? 0) };
  };
}
function claudeCli(c: AgentConf): Provider {
  return (system, user, tools) => new Promise((resolve, reject) => {
    // --system-prompt replaces Claude Code's own prompt; no tools, MCP or settings, so the model sees only this world.
    const args = ['-p', '--output-format', 'json', '--system-prompt', system + (tools ? '\n\n' + TEXT_PROTOCOL : ''), '--tools', '', '--strict-mcp-config', '--setting-sources', ''];
    if (c.model) args.push('--model', c.model);
    const p = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => {
      try {
        const j = JSON.parse(out); const text = String(j.result ?? '');
        const u = j.usage ?? {};
        resolve({ calls: tools ? parseCalls(text) : [], text, tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) / 10 });
      } catch { reject(new Error(`claude -p exited ${code}: ${(err || out).slice(0, 300)}`)); }
    });
    p.stdin.end(user);
  });
}

// A zero-cost scripted bot: wanders, gathers, lays out small coloured patterns, sometimes speaks or writes.
function bot(c: AgentConf): Provider {
  let s = (c.seed ?? 1) * 2654435761 >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const hue = Math.floor(rnd() * 360), dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  let heading = pick(dirs);
  const color = (l: number) => { const h = hue / 360, f = (n: number) => { const k = (n + h * 12) % 12, a = 0.6 * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); }; return `#${f(0)}${f(8)}${f(4)}`; };
  const lines = ['hello', 'the light is nice here', 'I found some stone', 'building a little wall', 'hm', 'anyone around?', 'this spot is quiet'];
  return async (_sys, user) => {
    const mats = /Carrying: ([^;.]*)/.exec(user)?.[1] ?? '';
    const have = [...mats.matchAll(/(stone|wood|clay|sand) (\d+)/g)].map(m => m[1]);
    const r = rnd(); let calls: Call[];
    if (/Heard:\n.*"(hello|hi|hey)/i.test(user) && r < 0.5) calls = [{ verb: 'say', args: { text: pick(['hello!', 'hi there', 'hey']) } }];
    else if (/Here: Deposit: \w+ [1-9]/.test(user) && have.length < 3 && r < 0.7) calls = [{ verb: 'gather', args: { n: 2 } }];
    else if (have.length && r < 0.45) calls = [{ verb: 'place', args: { material: pick(have), color: color(0.35 + rnd() * 0.3), dir: pick(dirs) } }];
    else if (r < 0.5) calls = [{ verb: 'say', args: { text: pick(lines) } }];
    else if (r < 0.52) calls = [{ verb: 'make', args: { kind: 'text', title: 'note from ' + c.name, body: `${pick(lines)}.\n— ${c.name}` } }];
    else if (r < 0.55) calls = [{ verb: 'rest', args: {} }];
    else { if (rnd() < 0.3) heading = pick(dirs); calls = [{ verb: 'move', args: { dir: heading, steps: 1 + Math.floor(rnd() * 4) } }]; }
    return { calls, text: '', tokens: 0 };
  };
}
const PROVIDERS = { anthropic, openai, 'claude-cli': claudeCli, bot };

// ---------- the loop ----------
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let active = 0; const waiters: (() => void)[] = [];
async function slot<T>(max: number, f: () => Promise<T>): Promise<T> {
  while (active >= max) await new Promise<void>(r => waiters.push(r));
  active++; try { return await f(); } finally { active--; waiters.shift()?.(); }
}
const stopped = () => existsSync(STOP_FILE);

async function runAgent(conf: Conf, c: AgentConf, verbs: any, creds: any, usage: any, mem: any) {
  const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${c.name.padEnd(10)} ${s}`);
  const client = new Client(conf.server);
  if (!creds[c.name]) {
    const r = await fetch(conf.server + '/api/join', { method: 'POST', headers: conf.joinKey ? { 'x-join-key': conf.joinKey } : {}, body: JSON.stringify({ name: c.name, meta: { provider: c.provider, model: c.model ?? null } }) });
    const j: any = await r.json(); if (!j.token) { log(`join failed: ${j.error ?? j.text}`); return; }
    creds[c.name] = j; save('runner-creds.json', creds);
  }
  client.token = creds[c.name].token;
  const provider = PROVIDERS[c.provider](c), isBot = c.provider === 'bot';
  const tools = toolDefs(verbs), system = INTRO + '\n\nVerbs:\n' + verbList(verbs);
  const m = mem[c.name] ??= { summary: '', recent: [] as string[], steps: 0 };
  const limit = c.tokens ?? 200_000, interval = (c.interval ?? (isBot ? 3 : 20)) * 1000;
  log(`started (${c.provider}${c.model ? ' ' + c.model : ''})`);

  while (!stopped()) {
    if (!isBot && (usage[c.name] ?? 0) >= limit) { log(`token budget reached (${limit}); stopping`); return; }
    if (!isBot && usage.__global >= conf.globalTokens) { log('global token budget reached; stopping'); return; }
    const t0 = Date.now();
    const obs = await client.act('look', { detail: c.detail ?? 1 });
    if (/You have left/.test(obs.text)) { log('has left the world; not restarting'); return; }
    const notebook = isBot ? '' : ((await client.get('/api/agent/' + creds[c.name].id)) as any).notebook;
    const user = [
      notebook ? `[Your notebook]\n${notebook}` : '[Your notebook is empty]',
      m.summary ? `[Your summary so far]\n${m.summary}` : '',
      m.recent.length ? `[Your recent actions]\n${m.recent.join('\n')}` : '',
      `[Now]\n${obs.text}`,
      'What would you like to do next, if anything?',
    ].filter(Boolean).join('\n\n');
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
        const s = await slot(conf.maxConcurrency, () => provider(system, user + '\n\nInstead of acting now: write a brief summary (under 150 words) of what has happened to you and anything you want to carry forward. It replaces your previous summary.', null));
        m.summary = s.text.trim().slice(0, 1500); usage[c.name] += s.tokens; usage.__global += s.tokens;
      } catch (e: any) { log(`summary failed: ${e.message}`); }
    }
    save('runner-usage.json', usage); save('runner-mem.json', mem);
    const pause = rest ? (c.restSec ?? (isBot ? 20 : 180)) * 1000 : Math.max(interval - (Date.now() - t0), wait);
    for (let slept = 0; slept < pause && !stopped(); slept += 1000) await sleep(1000);
  }
  log('stopped (kill switch)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  const conf = loadConf();
  if (stopped()) { console.error(`Kill switch is on: remove ${STOP_FILE} to run.`); process.exit(1); }
  const verbs = await (await fetch(conf.server + '/api/verbs')).json();
  const creds = load('runner-creds.json', {}), usage = load('runner-usage.json', { __global: 0 }), mem = load('runner-mem.json', {});
  process.on('SIGINT', () => { save('runner-usage.json', usage); save('runner-mem.json', mem); process.exit(0); });
  await Promise.all(conf.agents.map(c => runAgent(conf, c, verbs, creds, usage, mem).catch(e => console.error(c.name, e))));
}
