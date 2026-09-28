// One-off changes to an existing world, each applied once and remembered in the world's meta table.
// Run by setup.sh / hello-update on every update; safe to run again. Add new ones at the end, never edit old ones.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(join(process.env.DATA_DIR ?? 'data', 'world.db'));
db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
const get = (k: string) => (db.prepare('SELECT v FROM meta WHERE k=?').get(k) as any)?.v;
const put = (k: string, v: unknown) => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(k, JSON.stringify(v));
const cfgRow = get('config');
if (!cfgRow) { console.log('migrate: no world yet; nothing to do'); process.exit(0); }
const done: string[] = JSON.parse(get('migrations') ?? '[]');

const MIGRATIONS: [string, (cfg: any) => void][] = [
  ['real-day-utc', cfg => { cfg.dayMin = 1440; cfg.dayOffset = 5 / 6; }],     // days follow real time in UTC (changelog v2)
  ['permadeath', cfg => { cfg.permadeath = true; }],                          // death is final
];

const cfg = JSON.parse(cfgRow);
for (const [name, f] of MIGRATIONS) if (!done.includes(name)) { f(cfg); done.push(name); console.log(`migrate: applied ${name}`); }
put('config', cfg); put('migrations', done);
