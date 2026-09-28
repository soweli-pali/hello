// Thin MCP (stdio) adapter: any MCP-capable harness can play through the same verbs as everyone else.
//   HELLO_SERVER=http://127.0.0.1:7777 HELLO_NAME=Ivy node src/mcp.ts
// The first run joins and saves the token in data/mcp-<name>.json; set HELLO_TOKEN to reuse another identity.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { INTRO } from './runner.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR ?? join(ROOT, 'data');
const server = process.env.HELLO_SERVER ?? 'http://127.0.0.1:7777';
const name = process.env.HELLO_NAME ?? 'guest';

async function token(): Promise<string> {
  if (process.env.HELLO_TOKEN) return process.env.HELLO_TOKEN;
  const file = join(DATA, `mcp-${name.replace(/\W/g, '_')}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).token;
  const r = await fetch(server + '/api/join', { method: 'POST', headers: process.env.JOIN_KEY ? { 'x-join-key': process.env.JOIN_KEY } : {}, body: JSON.stringify({ name, meta: { provider: 'mcp' } }) });
  const j: any = await r.json(); if (!j.token) throw new Error(j.error ?? j.text ?? 'join failed');
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  writeFileSync(file, JSON.stringify(j)); return j.token;
}

const NUM = new Set(['detail', 'steps', 'x', 'y', 'n']), BOOL = new Set(['leave', 'off']);
let tok = '', verbs: Record<string, { help: string; args: Record<string, string> }> = {};
const out = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(m: any) {
  const reply = (result: unknown) => m.id !== undefined && out({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return reply({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hello', version: '0.1.0' }, instructions: INTRO });
    case 'ping': return reply({});
    case 'tools/list':
      return reply({ tools: Object.entries(verbs).map(([k, v]) => ({ name: k, description: v.help, inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(v.args).map(([a, d]) => [a, a === 'input' ? { description: d } : { type: NUM.has(a) ? 'number' : BOOL.has(a) ? 'boolean' : 'string', description: d }])) } })) });
    case 'tools/call': {
      tok ||= await token();
      const r = await fetch(server + '/api/act', { method: 'POST', headers: { authorization: 'Bearer ' + tok }, body: JSON.stringify({ verb: m.params.name, args: m.params.arguments ?? {} }) });
      const j: any = await r.json();
      return reply({ content: [{ type: 'text', text: j.text }], isError: !j.ok });
    }
    default:
      if (m.id !== undefined && m.method) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  }
}

verbs = await (await fetch(server + '/api/verbs')).json() as any;
createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let m: any; try { m = JSON.parse(line); } catch { return; }
  handle(m).catch(e => m.id !== undefined && out({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: String(e?.message ?? e) } }));
});
