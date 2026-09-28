// Animal people: each body is drawn as a small animal in a coat. Species and details are picked from the name,
// so a body always looks the same. draw(g, name, x, y, z, state) with (x, y) the tile centre and z pixels per tile.
const Critters = (() => {
  const hash = s => { let x = 2166136261; for (const c of String(s)) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } x ^= x >>> 15; x = Math.imul(x, 2246822507); x ^= x >>> 13; return x >>> 0; };
  const SPECIES = {
    fox:      { fur: '#d9772f', belly: '#f4e6d2', ear: 'point', tip: '#3a2418', snout: 'long', tail: 'bushy' },
    cat:      { fur: ['#9a9290', '#d8904a', '#3b3634', '#e9e1d6'], belly: '#f1e9df', ear: 'point', inner: '#e8a5a5', snout: 'whisk', tail: 'thin' },
    rabbit:   { fur: ['#e9e1d6', '#a07a5a', '#c8c0b8'], belly: '#f8f2ea', ear: 'long', inner: '#eeaab0', snout: 'nose', tail: 'puff' },
    bear:     { fur: ['#7a5234', '#4a3a30', '#c9a57a'], belly: '#d9b98f', ear: 'round', snout: 'muzzle', tail: 'none' },
    frog:     { fur: ['#6aa84f', '#8ab04a', '#4f8f7a'], belly: '#d8e8a8', ear: 'bulge', snout: 'grin', tail: 'none' },
    mouse:    { fur: ['#a8a09a', '#8a7060', '#e0d8d0'], belly: '#efe6dc', ear: 'big', inner: '#eeaab0', snout: 'nose', tail: 'thin' },
    owl:      { fur: ['#8a6a4a', '#b0a090', '#6a5a4a'], belly: '#e8dcc4', ear: 'tuft', snout: 'beak', tail: 'none', eyes: 'owl' },
    raccoon:  { fur: '#8f8c88', belly: '#dcd8d0', ear: 'round', snout: 'mask', tail: 'ringed' },
    duck:     { fur: ['#f2eee4', '#e8c85a', '#8a6a4a'], belly: '#fffaf0', ear: 'none', snout: 'bill', tail: 'none' },
    deer:     { fur: '#b8824e', belly: '#f0e0c8', ear: 'side', snout: 'nose', tail: 'puff', antler: true },
    badger:   { fur: '#5a5654', belly: '#e8e4dc', ear: 'round', snout: 'stripe', tail: 'none' },
    hedgehog: { fur: '#8a6a4e', belly: '#e8d4b8', ear: 'none', snout: 'nose', tail: 'none', spikes: true },
  };
  const NAMES = Object.keys(SPECIES);
  function look(name) {
    const h = hash(name), v = hash(name + '*'), sp = NAMES[h % NAMES.length], S = SPECIES[sp];
    const fur = Array.isArray(S.fur) ? S.fur[v % S.fur.length] : S.fur;
    return { sp, S, fur, coatHue: hash(name) % 360, hat: (v >> 7) % 4 === 0, scarf: (v >> 9) % 3 === 1 };
  }
  function draw(g, name, sx, sy, z, state, forceSpecies) {
    const L = look(name); if (forceSpecies) { L.sp = forceSpecies; L.S = SPECIES[forceSpecies]; L.fur = Array.isArray(L.S.fur) ? L.S.fur[0] : L.S.fur; }
    const { S, fur } = L, u = z / 16;
    const P = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(sx + x * u, sy + y * u, w * u, h * u); };
    const E = (x, y, rx, ry, c) => { g.fillStyle = c; g.beginPath(); g.ellipse(sx + x * u, sy + y * u, rx * u, ry * u, 0, 0, 7); g.fill(); };
    const coat = `hsl(${L.coatHue} 58% 50%)`, dark = `hsl(${L.coatHue} 50% 32%)`, ink = '#1d1714';
    E(0, 7, 5, 1.6, 'rgba(0,0,0,.28)');                                                  // shadow
    // tails go behind the body
    if (S.tail === 'bushy') { E(5.5, 3.5, 2.4, 3.2, fur); E(6.3, 1.2, 1.2, 1.2, S.belly); }
    if (S.tail === 'thin') { P(4, 4, 3, 1, fur); P(6, 1, 1, 3, fur); }
    if (S.tail === 'puff') E(4.6, 4.5, 1.5, 1.5, S.belly);
    if (S.tail === 'ringed') { for (let i = 0; i < 4; i++) P(4 + i * 0.9, 4 - i * 1.1, 1.4, 1.4, i % 2 ? '#2e2a28' : fur); }
    if (S.spikes) for (let i = 0; i < 9; i++) { const a = Math.PI * (1.08 + i * 0.105), b = a + 0.2, m = (a + b) / 2; g.fillStyle = i % 2 ? '#5a4432' : '#7a5c42'; g.beginPath(); g.moveTo(sx + Math.cos(a) * 4 * u, sy + (-4.6 + Math.sin(a) * 3.6) * u); g.lineTo(sx + Math.cos(m) * 6.6 * u, sy + (-4.6 + Math.sin(m) * 6) * u); g.lineTo(sx + Math.cos(b) * 4 * u, sy + (-4.6 + Math.sin(b) * 3.6) * u); g.fill(); }
    P(-3.2, 5.8, 2.6, 1.4, fur); P(0.6, 5.8, 2.6, 1.4, fur);                             // feet
    E(0, 2.6, 4.2, 3.9, dark); E(0, 2.4, 3.8, 3.6, coat); P(-0.4, -0.5, 0.8, 6, dark); // round coat
    E(-4.2, 2.6, 1.1, 2.2, coat); E(4.2, 2.6, 1.1, 2.2, coat); E(-4.3, 4.4, 1, 0.9, fur); E(4.3, 4.4, 1, 0.9, fur); // arms, paws
    if (L.scarf) { P(-3.6, -0.6, 7.2, 1.6, `hsl(${(L.coatHue + 150) % 360} 62% 58%)`); P(1.6, 0.6, 1.4, 2.4, `hsl(${(L.coatHue + 150) % 360} 62% 50%)`); }
    // ears behind the head
    const ear = S.ear;
    if (ear === 'point') { for (const s of [-1, 1]) { g.fillStyle = fur; g.beginPath(); g.moveTo(sx + s * 1.2 * u, sy - 8.5 * u); g.lineTo(sx + s * 4.4 * u, sy - 12 * u); g.lineTo(sx + s * 4.4 * u, sy - 6.5 * u); g.fill(); g.fillStyle = S.inner ?? S.tip ?? S.belly; g.beginPath(); g.moveTo(sx + s * 2.4 * u, sy - 8.8 * u); g.lineTo(sx + s * 4 * u, sy - 10.8 * u); g.lineTo(sx + s * 4 * u, sy - 8 * u); g.fill(); } }
    if (ear === 'long') for (const s of [-1, 1]) { E(s * 1.8, -12.5, 1.3, 4, fur); E(s * 1.8, -12.3, 0.6, 3, S.inner); }
    if (ear === 'round') for (const s of [-1, 1]) { E(s * 3.6, -8.6, 1.7, 1.7, fur); E(s * 3.6, -8.6, 0.8, 0.8, '#2e2a28'); }
    if (ear === 'big') for (const s of [-1, 1]) { E(s * 3.9, -8.4, 2.4, 2.4, fur); E(s * 3.9, -8.4, 1.5, 1.5, S.inner); }
    if (ear === 'side') for (const s of [-1, 1]) E(s * 4.8, -6.8, 2, 0.9, fur);
    if (ear === 'tuft') for (const s of [-1, 1]) { g.fillStyle = fur; g.beginPath(); g.moveTo(sx + s * 1.5 * u, sy - 8 * u); g.lineTo(sx + s * 4 * u, sy - 10.5 * u); g.lineTo(sx + s * 3.8 * u, sy - 6.5 * u); g.fill(); }
    if (S.antler) for (const s of [-1, 1]) { P(s * 2.4 - 0.4, -12, 0.8, 3.5, '#6b4a2e'); P(s * 2.4 + (s > 0 ? 0 : -1.6), -11.5, 2, 0.7, '#6b4a2e'); P(s * 3.8 - 0.3, -12.8, 0.7, 1.6, '#6b4a2e'); }
    if (ear === 'bulge') for (const s of [-1, 1]) { E(s * 2.3, -8.3, 1.9, 1.7, fur); E(s * 2.3, -8.4, 1.2, 1.2, '#fff'); E(s * 2.3, -8.3, 0.6, 0.7, ink); }
    // head
    E(0, -4.6, 4.4, 3.9, fur);
    if (S.snout !== 'grin' && S.snout !== 'bill') E(0, -3.2, 2.6, 2, S.belly);
    const shut = state === 'resting';
    const eye = (x, y) => shut ? P(x - 0.8, y, 1.6, 0.4, ink) : (P(x - 0.6, y - 0.7, 1.2, 1.5, ink), P(x - 0.2, y - 0.6, 0.45, 0.45, '#fff'));
    switch (S.snout) {
      case 'long': E(0, -2.6, 1.6, 1.2, S.belly); P(-0.6, -2.4, 1.2, 0.9, ink); break;
      case 'whisk': P(-0.5, -3.2, 1, 0.7, '#d98a8a'); for (const s of [-1, 1]) { P(s * 2.2 - (s < 0 ? 2 : 0), -3, 2, 0.25, '#f4efe6'); P(s * 2.2 - (s < 0 ? 2 : 0), -2.3, 2, 0.25, '#f4efe6'); } break;
      case 'nose': P(-0.5, -3.3, 1, 0.8, '#c86a70'); break;
      case 'muzzle': P(-0.7, -3.6, 1.4, 1, ink); P(-0.3, -2.4, 0.6, 0.6, ink); break;
      case 'grin': P(-2.6, -2.2, 5.2, 0.5, '#2e4a28'); break;
      case 'beak': g.fillStyle = '#e0a030'; g.beginPath(); g.moveTo(sx - 0.9 * u, sy - 3.8 * u); g.lineTo(sx + 0.9 * u, sy - 3.8 * u); g.lineTo(sx, sy - 2.2 * u); g.fill(); break;
      case 'bill': E(0, -2.6, 2.3, 1.1, '#e8902a'); P(-1.6, -2.7, 3.2, 0.3, '#b8661a'); break;
      case 'mask': P(-3.9, -6, 7.8, 2, '#2e2a28'); P(-0.5, -3.3, 1, 0.8, ink); break;
      case 'stripe': P(-0.8, -8.4, 1.6, 5, '#f4efe6'); for (const s of [-1, 1]) P(s * 2.2 - 0.6, -7, 1.2, 3.4, '#1f1c1a'); P(-0.5, -3.1, 1, 0.8, ink); break;
    }
    if (S.eyes === 'owl') { for (const s of [-1, 1]) { E(s * 1.8, -5, 1.6, 1.6, '#f4e6b0'); shut ? P(s * 1.8 - 1, -5, 2, 0.4, ink) : E(s * 1.8, -5, 0.7, 0.8, ink); } }
    else if (S.ear !== 'bulge') { eye(-1.7, -5.2); eye(1.7, -5.2); }
    if (!shut && S.snout !== 'grin') { P(-3.4, -3.6, 1, 0.6, 'rgba(240,120,120,.45)'); P(2.4, -3.6, 1, 0.6, 'rgba(240,120,120,.45)'); } // blush
    if (L.hat && !S.antler && S.ear !== 'long') { P(-4.6, -8.4, 9.2, 1.2, dark); P(-2.8, -11, 5.6, 2.8, dark); P(-2.8, -9.4, 5.6, 0.6, `hsl(${(L.coatHue + 40) % 360} 60% 60%)`); }
  }
  return { draw, look, SPECIES: NAMES };
})();
if (typeof module !== 'undefined') module.exports = Critters;
