// A chronicle of a stretch of the world's history, written by a model from the event log. For the observer.
//   node src/chronicle.ts [--data data] [--hours 24] [--model sonnet] [--notebooks] > chronicle.md
// It condenses events into plain lines, then asks for a short factual account: nothing invented, names and quotes kept.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PROVIDERS } from './runner.ts';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const db = new DatabaseSync(join(opt('data') ?? process.env.DATA_DIR ?? 'data', 'world.db'), { readOnly: true });
const rows = db.prepare('SELECT * FROM events ORDER BY seq').all() as any[];
const last = Math.max(...rows.filter(r => r.a).map(r => r.t), 0), from = last - Number(opt('hours') ?? 24) * 3600_000;
const names = new Map<string, string>(); const start = Math.min(...rows.filter(r => r.t >= from && r.a).map(r => r.t));
const hhmm = (t: number) => { const m = Math.round((t - start) / 60000); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

const lines: string[] = []; const burst = new Map<string, { n: number; kinds: Set<string>; t: number; x: number; y: number }>();
const flush = (a: string) => { const b = burst.get(a); if (b) { lines.push(`${hhmm(b.t)} ${names.get(a)} built ${b.n} blocks (${[...b.kinds].join(', ')}) near (${b.x},${b.y})`); burst.delete(a); } };
for (const r of rows) {
  const e = { ...JSON.parse(r.data), type: r.type, a: r.a, t: r.t }; const who = names.get(e.a) ?? e.a;
  if (e.type === 'join') names.set(e.a, e.name);
  if (r.t < from) continue;
  if (e.type !== 'place' && e.a) flush(e.a);
  switch (e.type) {
    case 'join': lines.push(`${hhmm(e.t)} ${e.name} arrived at (${e.x},${e.y})`); break;
    case 'say': lines.push(`${hhmm(e.t)} ${who}${e.loud ? ' shouted' : ' said'}: "${e.text}"`); break;
    case 'make': if (e.a) lines.push(`${hhmm(e.t)} ${who} made a ${e.kind} titled "${e.title}": ${String(e.body).slice(0, 200).replace(/\s+/g, ' ')}`); break;
    case 'craft': lines.push(`${hhmm(e.t)} ${who} crafted a ${e.title}`); break;
    case 'place': { const b = burst.get(e.a) ?? { n: 0, kinds: new Set<string>(), t: e.t, x: e.x, y: e.y }; b.n++; b.kinds.add(e.m + (e.dye ? ':' + e.dye.join('+') : '')); burst.set(e.a, b); break; }
    case 'transfer': if (e.to?.a) lines.push(`${hhmm(e.t)} ${who} gave ${e.item ? 'an item' : `${e.n} ${e.m}`} to ${names.get(e.to.a)}`); break;
    case 'strike': lines.push(`${hhmm(e.t)} ${who} struck ${e.target ? names.get(e.target) : `a ${e.animal}`}${e.killed ? ' and killed it' : ''}`); break;
    case 'die': lines.push(`${hhmm(e.t)} ${who} died (${e.cause})`); break;
    case 'tame': lines.push(`${hhmm(e.t)} ${who} won over an animal`); break;
    case 'use': if (e.reply) lines.push(`${hhmm(e.t)} ${who} used an object; it replied "${String(e.reply).slice(0, 120)}"`); break;
    case 'leave': lines.push(`${hhmm(e.t)} ${who} left the world`); break;
    case 'note': if (args.includes('--notebooks')) lines.push(`${hhmm(e.t)} (${who}'s private notebook) ${String(e.text).slice(-240).replace(/\s+/g, ' ')}`); break;
  }
}
for (const a of [...burst.keys()]) flush(a);
if (!lines.length) { console.log('Nothing happened in that stretch.'); process.exit(0); }
const text = lines.slice(-1500).join('\n');
const model = opt('model') ?? 'sonnet';
const p = PROVIDERS['claude-cli']({ name: 'chronicler', provider: 'claude-cli', model, maxTokens: 4000 });
const system = 'You write chronicles of a small world from its event log, for the person who watches it. Be strictly factual: use only what the log says, keep names and short quotes, never invent motives, feelings or events. Plain, warm prose. Headings by time of day if helpful. Under 600 words.';
const r = await p(system, `Here is the log (times are hours:minutes from the start of this stretch):\n\n${text}\n\nWrite the chronicle.`, null);
console.log(r.text);
