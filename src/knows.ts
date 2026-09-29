// What a body knows how to make, and which materials it has seen.
//   node src/knows.ts NAME        (DATA_DIR picks the world; default ./data)
import { join } from 'node:path';
import { World, RECIPES, BLOCKS } from './world.ts';
const name = process.argv[2]; if (!name) { console.error('usage: node src/knows.ts NAME'); process.exit(1); }
const w = new World(join(process.env.DATA_DIR ?? 'data', 'world.db'));
const a = [...w.agents.values()].find(a => a.name.toLowerCase() === name.toLowerCase());
if (!a) { console.error(`no one called ${name}; here: ${[...w.agents.values()].map(a => a.name).join(', ')}`); process.exit(1); }
const mats = [...a.knows!].filter(k => k.startsWith('mat:')).map(k => k.slice(4));
console.log(`${a.name} (${a.state})`);
console.log(`materials seen: ${mats.join(', ') || 'none yet'}`);
console.log(`recipes: ${Object.keys(RECIPES).filter(r => w.knowsRecipe(a, r)).join(', ') || 'none yet'}`);
console.log(`blocks: ${Object.keys(BLOCKS).filter(b => w.knowsBlock(a, b)).join(', ') || 'none yet'}`);
