// Animal people. Bare, a body is just a fluffy animal; what it wears (so far only a cloak) is drawn on top.
// An agent may choose its look when it joins: { species, fur, belly, eyes, mark, markColor }. Anything left out
// is picked from its name, so a body always looks the same. Used by the viewer and by the server's pictures.
//   Critters.draw(g, { name, look, worn, state }, x, y, z)   (x, y) = tile centre, z = pixels per tile
const Critters = (() => {
  const hash = s => { let x = 2166136261; for (const c of String(s)) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } x ^= x >>> 15; x = Math.imul(x, 2246822507); x ^= x >>> 13; return x >>> 0; };
  const SPECIES = {
    fox:      { fur: ['#d9772f', '#c8622a', '#e0a060'], belly: '#f4e6d2', ear: 'point', tip: '#3a2418', snout: 'long', tail: 'bushy' },
    cat:      { fur: ['#9a9290', '#d8904a', '#3b3634', '#e9e1d6'], belly: '#f1e9df', ear: 'point', inner: '#e8a5a5', snout: 'whisk', tail: 'thin' },
    rabbit:   { fur: ['#e9e1d6', '#a07a5a', '#c8c0b8'], belly: '#f8f2ea', ear: 'long', inner: '#eeaab0', snout: 'nose', tail: 'puff' },
    bear:     { fur: ['#7a5234', '#4a3a30', '#c9a57a'], belly: '#d9b98f', ear: 'round', snout: 'muzzle', tail: 'none' },
    frog:     { fur: ['#6aa84f', '#8ab04a', '#4f8f7a'], belly: '#d8e8a8', ear: 'bulge', snout: 'grin', tail: 'none' },
    mouse:    { fur: ['#a8a09a', '#8a7060', '#e0d8d0'], belly: '#efe6dc', ear: 'big', inner: '#eeaab0', snout: 'nose', tail: 'thin' },
    owl:      { fur: ['#8a6a4a', '#b0a090', '#6a5a4a'], belly: '#e8dcc4', ear: 'tuft', snout: 'beak', tail: 'none', eyes: 'owl' },
    raccoon:  { fur: ['#8f8c88', '#7a746e'], belly: '#dcd8d0', ear: 'round', snout: 'mask', tail: 'ringed' },
    duck:     { fur: ['#f2eee4', '#e8c85a', '#8a6a4a'], belly: '#fffaf0', ear: 'none', snout: 'bill', tail: 'none' },
    deer:     { fur: ['#b8824e', '#9a6a40'], belly: '#f0e0c8', ear: 'side', snout: 'nose', tail: 'puff', antler: true },
    badger:   { fur: ['#5a5654', '#6a6460'], belly: '#e8e4dc', ear: 'round', snout: 'stripe', tail: 'none' },
    hedgehog: { fur: ['#8a6a4e', '#a08060'], belly: '#e8d4b8', ear: 'none', snout: 'nose', tail: 'none', spikes: true },
  };
  const MARKS = ['none', 'spots', 'stripes', 'patch', 'socks'];
  const HEX = /^#[0-9a-f]{6}$/i;
  // What a joining agent may choose, and the check the server applies (unknown or malformed fields are dropped).
  function clean(look) {
    const o = {}; if (!look || typeof look !== 'object') return o;
    if (SPECIES[look.species]) o.species = look.species;
    for (const k of ['fur', 'belly', 'eyes', 'markColor']) if (HEX.test(String(look[k] ?? ''))) o[k] = String(look[k]).toLowerCase();
    if (MARKS.includes(look.mark)) o.mark = look.mark;
    return o;
  }
  function resolve(who) {
    const name = who.name ?? '', h = hash(name), v = hash(name + '*'), L = clean(who.look);
    const sp = L.species ?? Object.keys(SPECIES)[h % 12], S = SPECIES[sp];
    return { sp, S, fur: L.fur ?? S.fur[v % S.fur.length], belly: L.belly ?? S.belly, eyes: L.eyes ?? '#1d1714',
      mark: L.mark ?? (who.look ? 'none' : MARKS[(v >> 6) % 5]), markColor: L.markColor ?? '#f4efe6' };
  }
  const shade = (hex, k) => '#' + [1, 3, 5].map(i => Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * k))).toString(16).padStart(2, '0')).join('');
  function draw(g, who, sx, sy, z) {
    const L = resolve(who), { S, fur, belly } = L, u = z / 16, ink = L.eyes, shut = who.state === 'resting';
    const P = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(sx + x * u, sy + y * u, w * u, h * u); };
    const E = (x, y, rx, ry, c) => { g.fillStyle = c; g.beginPath(); g.ellipse(sx + x * u, sy + y * u, rx * u, ry * u, 0, 0, 7); g.fill(); };
    const T = (pts, c) => { g.fillStyle = c; g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(sx + x * u, sy + y * u) : g.moveTo(sx + x * u, sy + y * u)); g.fill(); };
    const dk = shade(fur, 0.72), cloak = (who.worn ?? []).includes('cloak');
    E(0, 7, 5, 1.6, 'rgba(0,0,0,.28)');
    if (S.tail === 'bushy') { E(5.5, 3.5, 2.4, 3.2, fur); E(6.3, 1.2, 1.2, 1.2, belly); }
    if (S.tail === 'thin') { P(4, 4, 3, 1, fur); P(6, 1, 1, 3, fur); }
    if (S.tail === 'puff') E(4.6, 4.5, 1.6, 1.6, belly);
    if (S.tail === 'ringed') for (let i = 0; i < 4; i++) P(4 + i * 0.9, 4 - i * 1.1, 1.4, 1.4, i % 2 ? '#2e2a28' : fur);
    if (S.spikes) for (let i = 0; i < 9; i++) { const a = Math.PI * (1.08 + i * 0.105), b = a + 0.2, m = (a + b) / 2; T([[Math.cos(a) * 4, -4.6 + Math.sin(a) * 3.6], [Math.cos(m) * 6.6, -4.6 + Math.sin(m) * 6], [Math.cos(b) * 4, -4.6 + Math.sin(b) * 3.6]], i % 2 ? shade(fur, 0.62) : shade(fur, 0.82)); }
    // a fluffy round body with a pale belly; little feet and paws
    E(-1.6, 6.3, 1.6, 1, dk); E(1.6, 6.3, 1.6, 1, dk);
    E(0, 2.6, 4.3, 4, dk); E(0, 2.4, 4, 3.8, fur); E(0, 3.2, 2.5, 2.7, belly);
    for (const [x, y] of [[-3.6, 0], [3.2, 1], [-3.8, 4], [3.6, 4.6]]) E(x, y, 0.9, 0.7, fur); // fluff tufts
    E(-4.1, 3, 1.1, 1.9, fur); E(4.1, 3, 1.1, 1.9, fur);
    if (L.mark === 'socks') { E(-1.6, 6.3, 1.5, 0.9, L.markColor); E(1.6, 6.3, 1.5, 0.9, L.markColor); E(-4.1, 4.3, 0.9, 0.7, L.markColor); E(4.1, 4.3, 0.9, 0.7, L.markColor); }
    if (L.mark === 'spots') for (const [x, y] of [[-2.2, 1.2], [2.4, 2.2], [-1.4, 4.6], [1.8, -6.6]]) E(x, y, 0.7, 0.6, L.markColor);
    // the one garment so far: a plain cloak, the same for everyone, over the shoulders
    if (cloak) { T([[-4.6, -0.8], [4.6, -0.8], [5.4, 6.2], [-5.4, 6.2]], '#6f6452'); T([[-4.6, -0.8], [4.6, -0.8], [3.4, 0.6], [-3.4, 0.6]], '#857a64'); E(0, -0.4, 0.8, 0.8, '#c9a15a'); }
    const ear = S.ear;
    if (ear === 'point') for (const s of [-1, 1]) { T([[s * 1.2, -8.5], [s * 4.4, -12], [s * 4.4, -6.5]], fur); T([[s * 2.4, -8.8], [s * 4, -10.8], [s * 4, -8]], S.inner ?? S.tip ?? belly); }
    if (ear === 'long') for (const s of [-1, 1]) { E(s * 1.8, -12.5, 1.3, 4, fur); E(s * 1.8, -12.3, 0.6, 3, S.inner); }
    if (ear === 'round') for (const s of [-1, 1]) { E(s * 3.6, -8.6, 1.7, 1.7, fur); E(s * 3.6, -8.6, 0.8, 0.8, shade(fur, 0.45)); }
    if (ear === 'big') for (const s of [-1, 1]) { E(s * 3.9, -8.4, 2.4, 2.4, fur); E(s * 3.9, -8.4, 1.5, 1.5, S.inner); }
    if (ear === 'side') for (const s of [-1, 1]) E(s * 4.8, -6.8, 2, 0.9, fur);
    if (ear === 'tuft') for (const s of [-1, 1]) T([[s * 1.5, -8], [s * 4, -10.5], [s * 3.8, -6.5]], fur);
    if (S.antler) for (const s of [-1, 1]) { P(s * 2.4 - 0.4, -12, 0.8, 3.5, '#6b4a2e'); P(s * 2.4 + (s > 0 ? 0 : -1.6), -11.5, 2, 0.7, '#6b4a2e'); P(s * 3.8 - 0.3, -12.8, 0.7, 1.6, '#6b4a2e'); }
    if (ear === 'bulge') for (const s of [-1, 1]) { E(s * 2.3, -8.3, 1.9, 1.7, fur); E(s * 2.3, -8.4, 1.2, 1.2, '#fff'); if (shut) P(s * 2.3 - 1, -8.4, 2, 0.4, ink); else E(s * 2.3, -8.3, 0.6, 0.7, ink); }
    E(0, -4.6, 4.5, 4, fur); E(-3.6, -2.6, 1, 0.8, fur); E(3.6, -2.6, 1, 0.8, fur); // fluffy cheeks
    if (S.snout !== 'grin' && S.snout !== 'bill') E(0, -3.2, 2.6, 2, belly);
    if (L.mark === 'stripes') for (const x of [-1.6, 0, 1.6]) P(x - 0.35, -8.5, 0.7, 2.2, L.markColor);
    if (L.mark === 'patch') E(1.8, -5.3, 1.6, 1.4, L.markColor);
    const eye = (x, y) => shut ? P(x - 0.8, y, 1.6, 0.4, ink) : (P(x - 0.6, y - 0.7, 1.2, 1.5, ink), P(x - 0.2, y - 0.6, 0.45, 0.45, '#fff'));
    switch (S.snout) {
      case 'long': E(0, -2.6, 1.6, 1.2, belly); P(-0.6, -2.4, 1.2, 0.9, '#1d1714'); break;
      case 'whisk': P(-0.5, -3.2, 1, 0.7, '#d98a8a'); for (const s of [-1, 1]) { P(s * 2.2 - (s < 0 ? 2 : 0), -3, 2, 0.25, '#f4efe6'); P(s * 2.2 - (s < 0 ? 2 : 0), -2.3, 2, 0.25, '#f4efe6'); } break;
      case 'nose': P(-0.5, -3.3, 1, 0.8, '#c86a70'); break;
      case 'muzzle': P(-0.7, -3.6, 1.4, 1, '#1d1714'); P(-0.3, -2.4, 0.6, 0.6, '#1d1714'); break;
      case 'grin': P(-2.6, -2.2, 5.2, 0.5, shade(fur, 0.45)); break;
      case 'beak': T([[-0.9, -3.8], [0.9, -3.8], [0, -2.2]], '#e0a030'); break;
      case 'bill': E(0, -2.6, 2.3, 1.1, '#e8902a'); P(-1.6, -2.7, 3.2, 0.3, '#b8661a'); break;
      case 'mask': P(-3.9, -6, 7.8, 2, '#2e2a28'); P(-0.5, -3.3, 1, 0.8, '#1d1714'); break;
      case 'stripe': P(-0.8, -8.4, 1.6, 5, '#f4efe6'); for (const s of [-1, 1]) P(s * 2.2 - 0.6, -7, 1.2, 3.4, '#1f1c1a'); P(-0.5, -3.1, 1, 0.8, '#1d1714'); break;
    }
    if (S.eyes === 'owl') for (const s of [-1, 1]) { E(s * 1.8, -5, 1.6, 1.6, '#f4e6b0'); if (shut) P(s * 1.8 - 1, -5, 2, 0.4, ink); else E(s * 1.8, -5, 0.7, 0.8, ink); }
    else if (ear !== 'bulge') { eye(-1.7, -5.2); eye(1.7, -5.2); }
    if (!shut && S.snout !== 'grin') { P(-3.4, -3.6, 1, 0.6, 'rgba(240,120,120,.45)'); P(2.4, -3.6, 1, 0.6, 'rgba(240,120,120,.45)'); }
  }
  // The world's animals, seen from the side. flip = -1 faces left. tame: a little collar in its person's colour.
  function beast(g, sp, sx, sy, z, flip = 1, tame = null) {
    const u = z / 16, f = flip < 0 ? -1 : 1;
    const P = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(sx + (f > 0 ? x : -x - w) * u, sy + y * u, w * u, h * u); };
    const E = (x, y, rx, ry, c) => { g.fillStyle = c; g.beginPath(); g.ellipse(sx + f * x * u, sy + y * u, rx * u, ry * u, 0, 0, 7); g.fill(); };
    const T = (pts, c) => { g.fillStyle = c; g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(sx + f * x * u, sy + y * u) : g.moveTo(sx + f * x * u, sy + y * u)); g.fill(); };
    E(0, 6.6, 5.5, 1.3, 'rgba(0,0,0,.28)');
    if (sp === 'deer') {
      const c = '#b8824e', d = '#8a5c34';
      for (const x of [-3.6, -2.2, 2.2, 3.6]) P(x - 0.45, 1.5, 0.9, 5, x < 0 ? d : c);
      E(-5, -0.8, 1.2, 1, '#f4ece0');                                 // tail
      E(0, 0.4, 5, 2.8, c); E(0, 1.8, 3.6, 1.1, '#e8d4b4');           // body, belly
      for (const [x, y] of [[-2, -0.8], [0, -1.4], [1.6, -0.4], [-0.8, 0.6]]) E(x, y, 0.45, 0.4, '#f4ece0');
      T([[3.2, -0.8], [4.6, -5.5], [6.2, -5], [5.4, 0]], c);          // neck
      E(6.4, -5.8, 1.9, 1.4, c); E(7.9, -5.4, 0.9, 0.7, '#e8d4b4'); P(8.3, -5.8, 0.6, 0.5, '#1d1714');
      E(5.2, -7.2, 0.6, 1.3, c); P(6.1, -6.6, 0.7, 0.7, '#1d1714');   // ear, eye
      P(5.6, -10, 0.5, 3, '#6b4a2e'); P(5.6, -10, 1.8, 0.5, '#6b4a2e'); P(6.9, -11, 0.5, 1.5, '#6b4a2e');
    } else if (sp === 'goat') {
      const c = '#eeeae0', d = '#cfc8b8';
      for (const x of [-3.4, -2, 2, 3.4]) { P(x - 0.5, 1.8, 1, 4.2, x < 0 ? d : c); P(x - 0.5, 5.4, 1, 0.8, '#4a4038'); }
      E(-4.8, -1, 1, 0.8, c);
      E(0, 0.5, 4.8, 2.9, c); for (const [x, y] of [[-3, 2.4], [-1, 2.8], [1, 2.8], [3, 2.4]]) E(x, y, 1, 0.7, d); // shaggy
      E(4.6, -2.8, 2, 2.2, c); E(6.2, -2.2, 1.6, 1.3, c);             // head
      T([[3.6, -4.2], [2.2, -6.2], [2.6, -6.4], [4.4, -4.6]], '#8a7a62'); T([[4.6, -4.4], [3.6, -6.6], [4, -6.8], [5.4, -4.6]], '#9a8a70'); // horns
      P(5.2, -3.6, 0.8, 0.7, '#1d1714'); T([[5.6, -1], [6.6, -1], [6.2, 1.2]], d); // eye, beard
      E(3.2, -3.4, 1.2, 0.5, d);                                      // ear
    } else if (sp === 'wolf') {
      const c = '#6f737b', d = '#4f535b', b = '#b8bcc2';
      T([[-4.2, -0.8], [-8, 1.6], [-7.4, 3], [-4, 1.2]], d); E(-7.4, 2.2, 0.9, 0.9, b);   // tail
      for (const x of [-3.4, -2, 2.2, 3.6]) P(x - 0.5, 1.4, 1, 5, x < 0 ? d : c);
      E(0, 0.2, 5, 2.7, c); E(0.4, 1.6, 3.4, 1, b);                   // body, belly
      T([[2.6, -1.8], [4.2, -4.6], [6.2, -4], [5, 0.4]], c);          // neck ruff
      E(5.8, -4.2, 2, 1.7, c); T([[6.8, -4.8], [10, -3.6], [9.6, -2.8], [6.8, -3]], c); P(9.6, -3.9, 0.7, 0.6, '#1d1714'); // head, snout, nose
      T([[4.8, -5.4], [5.2, -8], [6.4, -5.8]], d); T([[6, -5.4], [6.8, -7.8], [7.4, -5.4]], d); // ears
      P(6.6, -4.9, 0.9, 0.6, '#f0c44a');                              // eye
      P(7.2, -2.9, 2.2, 0.5, b);
    } else { E(0, 1, 4, 3, '#999'); }
    if (tame) { const c = `hsl(${hash(tame) % 360} 70% 55%)`; if (sp === 'goat') P(3.2, -1.2, 2.2, 0.9, c); else P(2.8, -2.2, 2, 0.9, c); }
  }
  return { draw, beast, clean, resolve, SPECIES: Object.keys(SPECIES), MARKS };
})();
globalThis.Critters = Critters;
