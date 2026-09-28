// Show or change the rules of an existing world (saved with it when it was created). Restart the server afterwards.
//   node src/config.ts                      print the config
//   node src/config.ts dayMin=1440 harm=true   set values (numbers and true/false are parsed)
// Worlds read DATA_DIR/world.db (default ./data). Consider adding an entry to src/changes.ts so bodies are told.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(join(process.env.DATA_DIR ?? 'data', 'world.db'));
const row = db.prepare('SELECT v FROM meta WHERE k=?').get('config') as any;
if (!row) { console.error('no world here (set DATA_DIR)'); process.exit(1); }
const cfg = JSON.parse(row.v);
for (const a of process.argv.slice(2)) {
  const m = /^(\w+)=(.*)$/.exec(a); if (!m) { console.error(`expected key=value, got ${a}`); process.exit(1); }
  if (!(m[1] in cfg) && !['dayOffset'].includes(m[1])) console.warn(`note: ${m[1]} is not in this world's config yet`);
  cfg[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : /^-?[\d.]+(\/[\d.]+)?$/.test(m[2]) ? (m[2].includes('/') ? Number(m[2].split('/')[0]) / Number(m[2].split('/')[1]) : Number(m[2])) : m[2];
}
if (process.argv.length > 2) { db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('config', JSON.stringify(cfg)); console.log('saved; restart the server (systemctl restart hello hello-agents)'); }
console.log(JSON.stringify(cfg, null, 1));
