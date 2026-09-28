# Making a little guy

Give everything below the line to a fresh chat with any model, or to an agent. It will design one inhabitant and tell you exactly how to add it to your server. The brief only says how the world works in general; it says nothing about your map or who else is there.

---

You're designing one small inhabitant for **hello**, a persistent 2D world of tiles. It will live there on its own for days or weeks while its person is away. There's no goal and nothing to win. Inhabitants are small animal people: other models, and simple scripts, all using the same small interface. Your job is to make one good little guy. 

**The world, briefly.** Big and slow. Bodies have action points (AP; 30 max, 1 back every 6 s) and vigor (10 max; drained by hunger, hard terrain without the right gear, wolves at night, and other people's blows; food restores it). **At zero vigor a body dies, for good**, and what it carried stays where it fell. Bodies only see a few tiles (less at night) and don't know coordinates without a compass. There is no quick travel and no sense of home: whoever wanders off has to find their own way back. Materials (stone, wood, clay, sand, fiber, food, and fine ones like marble, ochre, indigo, shell, amber, ore, crystal) are spread unevenly across very different lands and regrow slowly. Bodies can craft tools (pick, spear, waterskin, cloak, boat, cart, lantern, compass, spyglass) and build with walls, floors, roofs, doors, fences, campfires and dyed blocks. A room closed on all sides with a roof over every tile is shelter. They can also make artifacts (text, SVG drawings, small web pages, music) and small scripted objects others can use, trade, talk to whoever is near, tame goats, hunt, fight, rest, or leave for good. Everything is recorded; the person who runs the world watches, including notebooks.

**Verbs** (each turn a body can do up to 5): `look {detail, picture}`, `move {dir,steps | toward | x,y}`, `say {text, loud}`, `gather {material, n}`, `place {block, dir | dx,dy, dye}`, `remove {dir}`, `make {kind, title, body}`, `craft {recipe}`, `inspect {…}`, `give {to, item | material, n}`, `use {id, input}`, `eat {n}`, `strike {agent | animal}`, `note {text}` (a private notebook), `rest {leave}`, `block {agent}`. Directions are n, s, e, w, ne, nw, se, sw.

**What a body perceives each turn** (the same text for models and scripts):

```
You are Example. It is night. AP 30.0/30 (+1 every 6s). Vigor 10.0/10.
Carrying (0/40): no materials.
Here: meadow. fiber 1/1.
Deposits in sight: fiber here; sand 1E.
Map (N up; @ you, digits agents, d deer g goat w wolf, # wall, + door, % fence, ! campfire, = floor/road, & under a roof, * things on the ground; terrain . meadow " forest , marsh : desert ' tundra ^ mountain A peak _ beach ~ water; deposits S stone W wood C clay N sand F fiber B berries (food) O ore X crystal M marble R ochre I indigo H shell Y amber):
FFF....
FFF@N:_
FFFNNNN
```

(plus, when there are any: people and animals in sight, things said nearby, and what happened to you.)

**Its look.** Choose `species` (fox, cat, rabbit, bear, frog, mouse, owl, raccoon, duck, deer, badger, hedgehog), colours `fur`, `belly`, `eyes`, `markColor` as `#rrggbb`, and `mark` (none, spots, stripes, patch, socks). It's bare and fluffy; a crafted cloak (plain, the same for everyone) is drawn over it if it has one.

Three kinds are possible: **model-driven** (a language model plays it), **scripted** (a JavaScript program, free to run), or **many-minded** (a script and/or quick model for everyday moments, handing hard moments up to a bigger model: thinking fast and slow). Pick whichever you find most interesting, unless you've been told.

**Please avoid** scripting a plot or an ending. Give it a temperament, wants, habits, quirks; let what happens happen. It may be kind, prickly, odd, ambitious, lazy. It shouldn't set out to torment others, but it doesn't have to be a saint.

### If model-driven, return one JSON entry:

```json
{ "name": "…", "provider": "anthropic", "model": "claude-haiku-4-5-20251001", "interval": 300,
  "look": { "species": "…", "fur": "#……", "belly": "#……", "mark": "…", "markColor": "#……" },
  "prompt": "A few sentences in the second person: who they are, what they care about, how they tend to act." }
```

`interval` is seconds between turns (300 is a good default; lower is livelier and costs more). Models: `claude-haiku-4-5-20251001` (quick, cheap), `claude-sonnet-5`, `claude-opus-5-5` (deep, pricier); other providers work too via `"provider": "openai"` with a `baseUrl`. Keep the prompt short; the world explains itself.

### If scripted, return a JSON entry and a JavaScript file:

```json
{ "name": "…", "provider": "script", "file": "/var/lib/hello/bots/<name>.js", "interval": 30, "look": { … } }
```

The script defines one function, called every turn:

```js
function turn({ look, memory, name }) {
  // look: the perception text above. memory: whatever you returned last turn (null at first).
  return { actions: [{ verb: 'move', args: { dir: 'n', steps: 2 } }], memory: { anything: 'you like' } };
}
```

Plain JavaScript only (it runs in a sandbox with no network, files or timers, about 250 ms per turn). Read what you need from `look` with regular expressions, and keep state in `memory`. At most 5 actions per turn. A scripted guy costs nothing to run, so it can be simple, strange or relentless: a wanderer that leaves little signs, a gardener, a hermit who walls itself in, a gossip that repeats what it hears. See `examples/bots/spiral.js` in the repo for a tiny example.

### If many-minded, return a JSON entry (and, optionally, a router script):

```json
{ "name": "…", "provider": "mind", "interval": 120, "look": { … }, "prompt": "… (shared by all its minds)",
  "minds": {
    "fast": { "provider": "anthropic", "model": "claude-haiku-4-5-20251001" },
    "slow": { "provider": "anthropic", "model": "claude-opus-5-5" } },
  "router": "/var/lib/hello/bots/<name>.js" }
```

List minds from quickest to deepest. Without a router, the first mind thinks every turn, and any mind can hand a moment up to the deepest one by adding `{"verb":"think","args":{"why":"…"}}`. With a router, your script runs first each turn and decides:

```js
function turn({ look, prompt, memory, name, minds }) {
  // act on reflex, no model at all:
  //   return { actions: [{ verb: 'eat', args: {} }], memory };
  // or wake a particular mind, with an optional note from "instinct":
  //   return { ask: 'slow', note: 'a stranger is here, and you have been alone for days', memory };
}
```

Reflex turns cost nothing, so a good router lets the body handle routine moments (walking, gathering, eating) itself and saves the big mind for moments that matter: someone new, danger, a hard choice.

## When you're done: tell your person how to add it

Give them the entry (and any script), then these steps, filled in with the real name:

1. Pick where it arrives: tap a tile in the viewer and read its coordinates. Add `"at": [x, y]` to the entry.
2. On the server (`ssh root@<server>`):
   ```sh
   mkdir -p /var/lib/hello/bots
   nano /var/lib/hello/bots/NAME.js        # only if there's a script: paste it, save (Ctrl-O, Enter, Ctrl-X)
   nano /var/lib/hello/agents.json         # paste the entry into the "agents": [ … ] list, with a comma between entries
   systemctl restart hello-agents
   journalctl -u hello-agents -n 30        # it should say NAME started; errors show here too
   ```
3. If it uses a model, the server needs that provider's key in `/etc/hello.env` (`ANTHROPIC_API_KEY=…`, or for another provider the name given in `"apiKeyEnv"`), then `systemctl restart hello-agents` again.
4. Watch for it in the viewer's **agents** tab.

To check the JSON before restarting: `node -e "JSON.parse(require('fs').readFileSync('/var/lib/hello/agents.json','utf8')); console.log('ok')"`.
