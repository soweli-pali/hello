// hello viewer: read-only. All agent-authored content is rendered as text, as <img> (svg),
// or in a sandboxed iframe (html) served with a sandboxing CSP.
'use strict';
const $ = s => document.querySelector(s);
const STATIC = !!window.HELLO_STATIC; // set by the static export
// A single-file snapshot carries its data inline (window.HELLO_DATA: path -> text); otherwise static files, or the live API.
const EMBED = window.HELLO_DATA;
const api = p => EMBED ? (EMBED[staticPath(p)] != null ? Promise.resolve(JSON.parse(EMBED[staticPath(p)])) : Promise.reject(new Error('not in this snapshot')))
  : fetch(STATIC ? staticPath(p) : p).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
function staticPath(p) {
  const u = new URL(p, location.href), q = u.searchParams;
  if (u.pathname === '/api/tile') return `data/tile/${q.get('x')}_${q.get('y')}.json`;
  if (u.pathname === '/api/events') return 'data/events.json';
  if (u.pathname === '/api/items') return 'data/items.json';
  return 'data' + u.pathname.replace(/^\/api/, '') + '.json';
}
const raw = (id, kind) => {
  const path = `data/raw/${id}.${{ svg: 'svg', html: 'html' }[kind] ?? 'txt'}`;
  if (EMBED) return `data:${{ svg: 'image/svg+xml', html: 'text/html' }[kind] ?? 'text/plain'};charset=utf-8,` + encodeURIComponent(EMBED[path] ?? '');
  return STATIC ? path : `/api/item/${id}/raw`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) k === 'text' ? e.textContent = v : k === 'html' ? e.innerHTML = v : e.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
// the world's clock: real time live, or the moment a snapshot was taken
let SKEW = 0; const worldNow = () => Date.now() + SKEW;
const ago = t => { const s = Math.max(0, (worldNow() - t) / 1000 | 0); return s < 60 ? `${s}s` : s < 3600 ? `${s / 60 | 0}m` : s < 86400 ? `${s / 3600 | 0}h` : `${s / 86400 | 0}d`; };
const hueOf = s => { let x = 0; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) | 0; return Math.abs(x) % 360; };
const STR = new Proxy({}, { get: () => 1 }); // strength is only cosmetic client-side
const FLOORS = new Set(['cobble', 'floor', 'tile', 'cloth', 'garden', 'mosaic', 'fire']);
const kindOf = e => e.kind ?? (FLOORS.has(e.m) ? 'road' : 'wall');
const FIRE_MS = 4 * 3600_000, fireLit = b => b.m === 'fire' && worldNow() - (b.t ?? 0) < FIRE_MS;
const layerOf = kind => kind === 'roof' ? S.roofs : S.blocks;
const MATCOL = { stone: [150, 152, 158], wood: [52, 104, 44], clay: [184, 104, 70], sand: [226, 206, 136], fiber: [168, 196, 104], food: [200, 72, 112], ore: [132, 92, 176], crystal: [120, 236, 244], marble: [238, 235, 228], ochre: [181, 83, 47], indigo: [47, 64, 140], shell: [242, 222, 214], amber: [234, 165, 60] };
const BIOCOL = { sea: [18, 42, 68], river: [52, 106, 138], meadow: [78, 104, 60], forest: [36, 68, 42], marsh: [62, 80, 66], desert: [184, 156, 102], tundra: [146, 164, 160], mountain: [112, 104, 96], peak: [226, 232, 238], beach: [214, 198, 152] };
const BEAST = { deer: '#c89a62', goat: '#eeeae0', wolf: '#565b63' };

// ---------------- state ----------------
const S = { cfg: null, agents: new Map(), blocks: new Map(), roofs: new Map(), tileItems: new Map(), piles: new Set(), animals: new Map(), materials: [], biomes: [], spawn: [0, 0], seq: 0, speech: [], sel: null, time: null };
const cv = $('#map'), cx = cv.getContext('2d');
let terrain, blockLayer, W = 256, H = 256;
const view = { x: 128, y: 128, z: 4 }; // z = pixels per tile
let dirty = true;

async function boot() {
  const [snap, ter] = await Promise.all([api('/api/world'), api('/api/terrain')]);
  if (STATIC && snap.now) SKEW = snap.now - Date.now();
  S.cfg = snap.cfg; W = snap.cfg.w; H = snap.cfg.h; S.materials = snap.materials; S.biomes = snap.biomes; S.spawn = snap.spawn; S.seq = snap.seq;
  for (const a of snap.agents) S.agents.set(a.id, { ...a, dx: a.x, dy: a.y });
  for (const [x, y, color, m, s, kind, t] of snap.blocks) S.blocks.set(`${x},${y}`, { color, m, s, kind, t });
  for (const [x, y, color, m] of snap.roofs ?? []) S.roofs.set(`${x},${y}`, { color, m, s: 1, kind: 'roof' });
  for (const [x, y] of snap.piles ?? []) S.piles.add(`${x},${y}`);
  for (const [x, y, n] of snap.tileItems) S.tileItems.set(`${x},${y}`, n);
  buildTerrain(ter.data, ter.elev); rebuildBlocks(); buildClouds();
  if (typeof TileArt !== 'undefined') TileArt.init({ W, H, bytes: S.bytes, elev: S.elev, biomes: S.biomes, materials: S.materials, colors: { biome: BIOCOL } });
  $('#loading')?.classList.add('gone');
  const saved = JSON.parse(localStorage.getItem('hello.view') || 'null');
  if (saved) Object.assign(view, saved); else fit();
  resize(); stats(); route();
  if (!STATIC) stream();
  pollAnimals(); if (!STATIC) setInterval(pollAnimals, 3000);
  setInterval(() => { dirty = true; stats(); }, 15000);
  requestAnimationFrame(frame);
}

function buildTerrain(b64, elev64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const el = elev64 ? Uint8Array.from(atob(elev64), c => c.charCodeAt(0)) : new Uint8Array(W * H).fill(100);
  S.bytes = bytes; S.elev = el;
  terrain = document.createElement('canvas'); terrain.width = W; terrain.height = H;
  const tc = terrain.getContext('2d'), img = tc.createImageData(W, H);
  const isWater = i => { const b = S.biomes[bytes[i] >> 4]; return b === 'sea' || b === 'river'; };
  const E = (x, y) => el[Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))];
  for (let i = 0; i < W * H; i++) {
    const v = bytes[i], b = S.biomes[v >> 4], m = v & 15, x = i % W, y = i / W | 0;
    const h = ((x * 73856093) ^ (y * 19349663)) >>> 0, n = h % 7 - 3; // faint texture
    let c;
    if (b === 'sea') {
      // deeper water is darker; the shelf near land is lighter, with a pale lip where it meets the shore
      const d = Math.max(0, Math.min(1, E(x, y) / 60)), shore = !isWater(i - 1) || !isWater(i + 1) || !isWater(i - W) || !isWater(i + W);
      c = [14 + 34 * d * d, 32 + 62 * d * d, 56 + 66 * d * d].map(v => v + n * 0.5);
      if (shore) c = c.map(v => v * 0.6 + 150 * 0.4);
    } else {
      c = BIOCOL[b].map(v => v + n * (b === 'peak' ? 0.8 : 1.8));
      if (b === 'forest' && h % 5 === 0) c = c.map(v => v * 0.72); // canopy
      if (b === 'desert' && h % 11 === 0) c = c.map(v => v * 1.06);
      // hillshade, lit from the north-west
      if (b !== 'river') { const sh = Math.max(0.55, Math.min(1.4, 1 + (E(x - 1, y - 1) - E(x + 1, y + 1)) * (b === 'peak' || b === 'mountain' ? 0.035 : 0.05))); c = c.map(v => v * sh); }
    }
    if (m) { const mat = S.materials[m - 1], mc = MATCOL[mat], a = mat === 'crystal' || mat === 'ore' ? 0.85 : ['marble', 'ochre', 'indigo', 'amber', 'shell'].includes(mat) ? 0.55 : 0.16; c = c.map((v, k) => v * (1 - a) + mc[k] * a); }
    img.data.set([c[0], c[1], c[2], 255], i * 4);
  }
  tc.putImageData(img, 0, 0);
}
// Soft cloud shadows drifting over the land, visible when zoomed out.
let clouds;
function buildClouds() {
  const N = 128, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'), img = g.createImageData(N, N);
  const hs = (x, y, s) => { let v = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0; v = Math.imul(v ^ (v >>> 13), 1274126177); return ((v ^ (v >>> 16)) >>> 0) / 4294967296; };
  const vn = (x, y, sc, s) => { const gx = x / sc, gy = y / sc, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), P = N / sc;
    const q = (a, b) => hs(((a % P) + P) % P, ((b % P) + P) % P, s); const A = q(x0, y0), B = q(x0 + 1, y0), C = q(x0, y0 + 1), D = q(x0 + 1, y0 + 1); return A + (B - A) * sx + (C - A) * sy + (A - B - C + D) * sx * sy; };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = vn(x, y, 32, 1) * 0.6 + vn(x, y, 16, 2) * 0.3 + vn(x, y, 8, 3) * 0.1, a = Math.max(0, v - 0.55) / 0.45;
    img.data.set([10, 16, 24, Math.round(a * a * 120)], (y * N + x) * 4);
  }
  g.putImageData(img, 0, 0); clouds = c;
}
function drawClouds(ox, oy, z) {
  if (!clouds || z > 10) return;
  const fade = z < 5 ? 1 : (10 - z) / 5, scale = 7 * z, span = 128 * scale, t = Date.now() / 1000;
  const offx = ((t * 0.35 * z) % span + span) % span, offy = ((t * 0.12 * z) % span + span) % span;
  cx.save(); cx.globalAlpha = fade; cx.imageSmoothingEnabled = true;
  cx.beginPath(); cx.rect(ox, oy, W * z, H * z); cx.clip();
  for (let yy = oy - span + offy; yy < innerHeight; yy += span) for (let xx = ox - span + offx; xx < innerWidth; xx += span) if (xx + span > 0 && yy + span > 0) cx.drawImage(clouds, xx, yy, span, span);
  cx.restore(); cx.imageSmoothingEnabled = false;
}
function drawMinimap() {
  const mm = $('#minimap'); if (!mm) return;
  const show = view.z >= 5 && terrain; mm.hidden = !show; document.body.classList.toggle('mm', !!show); if (!show) return;
  const d = devicePixelRatio || 1, size = mm.clientWidth; if (mm.width !== size * d) { mm.width = mm.height = size * d; }
  const g = mm.getContext('2d'), k = mm.width / Math.max(W, H);
  g.imageSmoothingEnabled = true; g.drawImage(terrain, 0, 0, W * k, H * k); g.drawImage(blockLayer, 0, 0, W * k, H * k);
  g.fillStyle = '#f4efe2';
  for (const a of S.agents.values()) if (a.state !== 'left' && a.state !== 'dead') g.fillRect(a.x * k - d, a.y * k - d, 2 * d, 2 * d);
  const [x0, y0] = toWorld(0, 0), [x1, y1] = toWorld(innerWidth, innerHeight);
  g.strokeStyle = '#f0c46a'; g.lineWidth = 1.5 * d; g.strokeRect(x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k);
}
function rebuildBlocks(blocks = S.blocks, roofs = S.roofs) {
  blockLayer = document.createElement('canvas'); blockLayer.width = W; blockLayer.height = H;
  const bc = blockLayer.getContext('2d');
  for (const L of [blocks, roofs]) for (const [k, b] of L) { const [x, y] = k.split(',').map(Number); bc.fillStyle = b.color; bc.fillRect(x, y, 1, 1); }
  dirty = true;
}
function paintBlock(x, y) {
  const k = `${x},${y}`, bc = blockLayer.getContext('2d'), b = S.roofs.get(k) ?? S.blocks.get(k);
  bc.clearRect(x, y, 1, 1); if (b) { bc.fillStyle = b.color; bc.fillRect(x, y, 1, 1); }
  dirty = true;
}

// ---------------- rendering ----------------
function resize() { const d = devicePixelRatio || 1; cv.width = innerWidth * d; cv.height = innerHeight * d; dirty = true; }
addEventListener('resize', resize);
function toScreen(x, y) { return [(x - view.x) * view.z + innerWidth / 2, (y - view.y) * view.z + innerHeight / 2]; }
function toWorld(sx, sy) { return [(sx - innerWidth / 2) / view.z + view.x, (sy - innerHeight / 2) / view.z + view.y]; }
function fit() { view.x = W / 2; view.y = H / 2; view.z = Math.min(innerWidth, innerHeight - 80) / Math.max(W, H) * 0.95; dirty = true; }

function frame() {
  // ease agents toward their positions
  for (const a of S.agents.values()) {
    const ex = a.x - a.dx, ey = a.y - a.dy;
    if (Math.abs(ex) + Math.abs(ey) > 0.01) { a.dx += ex * 0.15; a.dy += ey * 0.15; dirty = true; } else { a.dx = a.x; a.dy = a.y; }
  }
  for (const an of S.animals.values()) {
    const ex = an.x - an.dx, ey = an.y - an.dy;
    if (Math.abs(ex) + Math.abs(ey) > 0.01) { an.dx += ex * 0.05; an.dy += ey * 0.05; dirty = true; } else { an.dx = an.x; an.dy = an.y; }
  }
  if (S.speech.length && S.speech[0].until < Date.now()) { S.speech = S.speech.filter(s => s.until > Date.now()); dirty = true; }
  const now = performance.now();
  if (view.z <= 10 && now - (frame.last ?? 0) > 80) { dirty = true; } // clouds drift
  if (dirty) { frame.last = now; draw(); drawMinimap(); dirty = false; }
  requestAnimationFrame(frame);
}
function draw() {
  const d = devicePixelRatio || 1, z = view.z;
  cx.setTransform(d, 0, 0, d, 0, 0);
  cx.fillStyle = '#0b0e0c'; cx.fillRect(0, 0, innerWidth, innerHeight);
  cx.imageSmoothingEnabled = false;
  const [ox, oy] = toScreen(0, 0);
  cx.drawImage(terrain, ox, oy, W * z, H * z);
  cx.drawImage(blockLayer, ox, oy, W * z, H * z);
  const [x0, y0] = toWorld(0, 0).map(Math.floor), [x1, y1] = toWorld(innerWidth, innerHeight).map(Math.ceil);
  // Up close the land becomes drawn tiles; fade them in over the smooth overview as you zoom.
  const tileA = Math.max(0, Math.min(1, (z - 5) / 3));
  if (tileA > 0 && typeof TileArt !== 'undefined') {
    const C = TileArt.CH, list = [];
    for (let cy2 = Math.max(0, Math.floor(y0 / C)); cy2 <= Math.min(Math.floor((H - 1) / C), Math.floor(y1 / C)); cy2++)
      for (let cx2 = Math.max(0, Math.floor(x0 / C)); cx2 <= Math.min(Math.floor((W - 1) / C), Math.floor(x1 / C)); cx2++) list.push([cx2, cy2]);
    if (!TileArt.ensure(list)) dirty = true;
    cx.globalAlpha = tileA; cx.imageSmoothingEnabled = z < TileArt.PX;
    for (const [cx2, cy2] of list) { const c = TileArt.chunk(cx2, cy2); if (!c) continue; const [sx, sy] = toScreen(cx2 * C, cy2 * C); cx.drawImage(c, Math.floor(sx), Math.floor(sy), Math.ceil(C * z) + 1, Math.ceil(C * z) + 1); }
    cx.imageSmoothingEnabled = false;
    // blocks, drawn as what they are; walls cast a short shadow to the south
    for (const [k, b] of S.blocks) {
      const [x, y] = k.split(',').map(Number); if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const [sx, sy] = toScreen(x, y), fence = b.m === 'fence';
      cx.drawImage(TileArt.block(b.m === 'fire' && !fireLit(b) ? 'ash' : b.m, b.color, b.kind !== 'road' && !fence), sx, sy, Math.ceil(z), Math.ceil(z));
      // a wall has a face: where nothing tall stands south of it, draw its darker front and the shadow it throws
      if (b.kind !== 'road' && !fence && S.blocks.get(`${x},${y + 1}`)?.kind !== 'wall') {
        const fh = z * 0.3; cx.globalAlpha = tileA * 0.55; cx.drawImage(TileArt.block(b.m, b.color, false), sx, sy + z, Math.ceil(z), fh);
        cx.fillStyle = `rgba(0,0,0,${0.35 * tileA})`; cx.fillRect(sx, sy + z, Math.ceil(z), fh); cx.fillStyle = `rgba(0,0,0,${0.18 * tileA})`; cx.fillRect(sx, sy + z + fh, Math.ceil(z), fh * 0.6);
        cx.globalAlpha = tileA;
      }
    }
    // roofs are pitched east-west: the north slope catches the light, the south slope is in shade, a ridge runs between
    const roofA = tileA * (z >= 28 ? 0.3 : z >= 20 ? 0.7 : 1);
    for (const [k, b] of S.roofs) {
      const [x, y] = k.split(',').map(Number); if (x < x0 || x > x1 || y < y0 - 1 || y > y1) continue;
      const [sx, sy] = toScreen(x, y);
      cx.globalAlpha = roofA; cx.drawImage(TileArt.block(b.m, b.color, false), sx, sy, Math.ceil(z), Math.ceil(z));
      let up = 0, dn = 0; while (up < 30 && S.roofs.has(`${x},${y - up - 1}`)) up++; while (dn < 30 && S.roofs.has(`${x},${y + dn + 1}`)) dn++;
      if (up + dn >= 2) {
        if (up > dn) { cx.fillStyle = 'rgba(0,0,0,.16)'; cx.fillRect(sx, sy, Math.ceil(z), Math.ceil(z)); } else if (up < dn) { cx.fillStyle = 'rgba(255,240,210,.07)'; cx.fillRect(sx, sy, Math.ceil(z), Math.ceil(z)); }
        if (up === dn || up === dn + 1) { const ry = up === dn ? sy + z * 0.45 : sy - z * 0.05; cx.fillStyle = 'rgba(0,0,0,.28)'; cx.fillRect(sx, ry + z * 0.1, Math.ceil(z), Math.max(1, z * 0.06)); cx.fillStyle = 'rgba(255,255,255,.18)'; cx.fillRect(sx, ry, Math.ceil(z), Math.max(1, z * 0.1)); }
      }
      if (!S.roofs.has(`${x},${y - 1}`)) { cx.fillStyle = 'rgba(255,255,255,.16)'; cx.fillRect(sx, sy, Math.ceil(z), Math.max(1, z * 0.1)); }
      if (!S.roofs.has(`${x},${y + 1}`)) { cx.fillStyle = 'rgba(0,0,0,.3)'; cx.fillRect(sx, sy + z * 0.88, Math.ceil(z), z * 0.12); cx.fillStyle = 'rgba(0,0,0,.22)'; cx.fillRect(sx, sy + z, Math.ceil(z), z * 0.35); }
      if (!S.roofs.has(`${x - 1},${y}`)) { cx.fillStyle = 'rgba(255,255,255,.08)'; cx.fillRect(sx, sy, Math.max(1, z * 0.08), Math.ceil(z)); }
      if (!S.roofs.has(`${x + 1},${y}`)) { cx.fillStyle = 'rgba(0,0,0,.18)'; cx.fillRect(sx + z * 0.92, sy, z * 0.08, Math.ceil(z)); }
    }
    cx.globalAlpha = 1;
  }
  if (z >= 10) { // items
    for (const [k, n] of S.tileItems) {
      if (!n) continue; const [x, y] = k.split(',').map(Number); if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const [sx, sy] = toScreen(x + 0.5, y + 0.55), r = z * 0.16;
      cx.fillStyle = 'rgba(0,0,0,.25)'; cx.fillRect(sx - r + 1, sy - r * 0.7 + 1.5, 2 * r, 1.4 * r);
      cx.fillStyle = '#efe4c8'; cx.fillRect(sx - r, sy - r * 0.7, 2 * r, 1.4 * r); cx.fillStyle = '#c9b48a'; cx.fillRect(sx - r * 0.6, sy - r * 0.25, r * 1.2, Math.max(1, r * 0.12)); cx.fillRect(sx - r * 0.6, sy + r * 0.15, r * 0.9, Math.max(1, r * 0.12));
    }
  } else if (z >= 3) {
    cx.fillStyle = '#f0c46a';
    for (const [k, n] of S.tileItems) { if (!n) continue; const [x, y] = k.split(',').map(Number); const [sx, sy] = toScreen(x + 0.5, y + 0.5); cx.fillRect(sx - 1, sy - 1, 2, 2); }
  }
  if (z >= 6) for (const k of S.piles) {
    const [x, y] = k.split(',').map(Number); if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const [sx, sy] = toScreen(x + 0.72, y + 0.72); cx.fillStyle = '#8a6a44'; cx.beginPath(); cx.arc(sx, sy, z * 0.11, 0, 7); cx.fill(); cx.fillStyle = '#a8845a'; cx.beginPath(); cx.arc(sx - z * 0.03, sy - z * 0.04, z * 0.06, 0, 7); cx.fill();
  }
  if (z >= 1.5 && S.cfg.safeRadius > 0) { // safe ground, if this world has any
    const r = S.cfg.safeRadius, [sx, sy] = toScreen(S.spawn[0] - r, S.spawn[1] - r);
    cx.setLineDash([4, 4]); cx.strokeStyle = '#f0c46a55'; cx.lineWidth = 1; cx.strokeRect(sx, sy, (2 * r + 1) * z, (2 * r + 1) * z); cx.setLineDash([]);
  }
  for (const an of S.animals.values()) {
    if (an.dx < x0 - 1 || an.dx > x1 + 1 || an.dy < y0 - 1 || an.dy > y1 + 1) continue;
    const [sx, sy] = toScreen(an.dx + 0.5, an.dy + 0.5), r = Math.max(1.2, z * (an.sp === 'wolf' ? 0.3 : 0.24));
    cx.fillStyle = BEAST[an.sp];
    if (an.sp === 'wolf') { cx.beginPath(); cx.moveTo(sx, sy - r); cx.lineTo(sx + r, sy + r * 0.8); cx.lineTo(sx - r, sy + r * 0.8); cx.fill(); }
    else { cx.beginPath(); cx.arc(sx, sy, r, 0, 7); cx.fill(); }
    if (z >= 14) { cx.fillStyle = '#0b0e0c'; cx.font = `600 ${Math.round(z * 0.3)}px sans-serif`; cx.textAlign = 'center'; cx.fillText(an.sp[0], sx, sy + z * 0.1); }
  }
  drawClouds(ox, oy, z);
  const dark = darkness();
  if (dark > 0) {
    cx.fillStyle = `rgba(8, 12, 32, ${dark})`; cx.fillRect(0, 0, innerWidth, innerHeight);
    // bodies carry a little warmth into the dark, and crystal and amber give light
    cx.globalCompositeOperation = 'lighter';
    for (const [k, b] of S.blocks) {
      if (b.m !== 'crystal' && b.m !== 'lamp' && !fireLit(b)) continue;
      const [x, y] = k.split(',').map(Number); if (x < x0 - 4 || x > x1 + 4 || y < y0 - 4 || y > y1 + 4) continue;
      const [sx, sy] = toScreen(x + 0.5, y + 0.5), r = Math.max(8, z * (b.m === 'fire' ? 4.5 : 3.5)), gl = cx.createRadialGradient(sx, sy, 0, sx, sy, r);
      const c = b.m === 'crystal' ? '140, 235, 255' : b.m === 'fire' ? '255, 150, 60' : '255, 190, 100';
      gl.addColorStop(0, `rgba(${c}, ${0.5 * dark})`); gl.addColorStop(1, `rgba(${c}, 0)`); cx.fillStyle = gl; cx.fillRect(sx - r, sy - r, 2 * r, 2 * r);
    }
    for (const a of S.agents.values()) {
      if (a.state === 'left' || a.state === 'dead') continue;
      const [sx, sy] = toScreen(a.dx + 0.5, a.dy + 0.5), r = Math.max(10, z * 2.2), gl = cx.createRadialGradient(sx, sy, 0, sx, sy, r);
      gl.addColorStop(0, `rgba(255, 196, 120, ${0.35 * dark})`); gl.addColorStop(1, 'rgba(255, 196, 120, 0)');
      cx.fillStyle = gl; cx.fillRect(sx - r, sy - r, 2 * r, 2 * r);
    }
    cx.globalCompositeOperation = 'source-over';
  }
  if (S.hover && z >= 6 && matchMedia('(hover: hover)').matches) { const [sx, sy] = toScreen(S.hover.x, S.hover.y); cx.strokeStyle = '#ffffff55'; cx.lineWidth = 1; cx.strokeRect(sx + 0.5, sy + 0.5, z - 1, z - 1); }
  if (S.sel) { const [sx, sy] = toScreen(S.sel.x, S.sel.y); cx.strokeStyle = '#f0c46a'; cx.lineWidth = 2; cx.strokeRect(sx - 1, sy - 1, Math.max(z, 4) + 2, Math.max(z, 4) + 2); }
  // agents
  cx.textAlign = 'center'; cx.font = '600 12px ' + getComputedStyle(document.body).fontFamily;
  const labels = [];
  for (const a of S.agents.values()) {
    if (a.state === 'left') continue;
    const [sx, sy] = toScreen(a.dx + 0.5, a.dy + 0.5), r = Math.max(3, z * 0.36);
    if (a.state === 'dead') { cx.strokeStyle = '#d9d4c7aa'; cx.lineWidth = 2; cx.beginPath(); cx.moveTo(sx - r, sy - r); cx.lineTo(sx + r, sy + r); cx.moveTo(sx + r, sy - r); cx.lineTo(sx - r, sy + r); cx.stroke(); continue; }
    cx.globalAlpha = a.state === 'resting' ? 0.5 : 1;
    if (z >= 12) drawPerson(a, sx, sy, z);
    else { cx.fillStyle = `hsl(${hueOf(a.name)} 75% 62%)`; cx.strokeStyle = '#0b0e0c'; cx.lineWidth = 2; cx.beginPath(); cx.arc(sx, sy, r, 0, 7); cx.fill(); cx.stroke(); }
    if (z >= 7) { // skip a name that would sit on top of one already drawn
      const ly = z >= 12 ? sy - z * 0.8 - 5 : sy - r - 5, w2 = cx.measureText(a.name).width / 2 + 3;
      if (!labels.some(l => Math.abs(l[0] - sx) < l[2] + w2 && Math.abs(l[1] - ly) < 13)) {
        labels.push([sx, ly, w2]); cx.lineWidth = 3; cx.strokeStyle = '#0b0e0caa'; cx.strokeText(a.name, sx, ly);
        cx.fillStyle = '#eef1ea'; cx.fillText(a.name + (a.state === 'resting' ? ' z' : ''), sx, ly);
      }
    }
    cx.globalAlpha = 1;
  }
  // speech bubbles
  if (z >= 5) for (const s of S.speech) {
    const a = S.agents.get(s.a); if (!a) continue;
    const [sx, sy] = toScreen(a.dx + 0.5, a.dy + 0.5), text = s.text.length > 60 ? s.text.slice(0, 58) + '…' : s.text;
    cx.font = '12px ' + getComputedStyle(document.body).fontFamily;
    const w = cx.measureText(text).width + 12, y = sy - Math.max(3, z * 0.36) - (z >= 7 ? 38 : 22);
    cx.fillStyle = '#f4f1e8ee'; cx.beginPath(); cx.roundRect(sx - w / 2, y, w, 20, 8); cx.fill();
    cx.fillStyle = '#1a1d1a'; cx.fillText(text, sx, y + 14);
  }
}

function drawPerson(a, sx, sy, z) { Critters.draw(cx, { name: a.name, look: a.meta?.look, worn: (a.tools ?? []).includes('cloak') ? ['cloak'] : [], state: a.state }, sx, sy + z * 0.05, z); }
function phase(t = worldNow()) { return (t / (S.cfg.dayMin * 60000) + (S.cfg.dayOffset ?? 0.3)) % 1; }
function darkness() { const p = phase(); return p >= 0.75 ? 0.5 : p > 0.62 ? (p - 0.62) / 0.13 * 0.5 : p < 0.06 ? (0.06 - p) / 0.06 * 0.5 : 0; }
async function pollAnimals() {
  if (S.time) return;
  try {
    const r = await api('/api/animals'), seen = new Set();
    for (const an of r.animals) { seen.add(an.id); const o = S.animals.get(an.id); if (o) Object.assign(o, an); else S.animals.set(an.id, { ...an, dx: an.x, dy: an.y }); }
    for (const id of S.animals.keys()) if (!seen.has(id)) S.animals.delete(id);
    dirty = true;
  } catch { /* animals are decoration for the observer */ }
}

// ---------------- input: pan, pinch, wheel, tap ----------------
const ptrs = new Map(); let gesture = null, moved = 0;
cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); moved = ptrs.size > 1 ? 99 : 0; startGesture(); });
cv.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) return;
  const p = ptrs.get(e.pointerId); moved += Math.abs(e.clientX - p[0]) + Math.abs(e.clientY - p[1]);
  ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  const pts = [...ptrs.values()];
  if (pts.length === 1 && gesture) { view.x = gesture.vx - (pts[0][0] - gesture.cx) / view.z; view.y = gesture.vy - (pts[0][1] - gesture.cy) / view.z; }
  else if (pts.length >= 2 && gesture) {
    const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]), mx = (pts[0][0] + pts[1][0]) / 2, my = (pts[0][1] + pts[1][1]) / 2;
    view.z = clampZ(gesture.z * d / gesture.d);
    view.x = gesture.wx - (mx - innerWidth / 2) / view.z; view.y = gesture.wy - (my - innerHeight / 2) / view.z;
  }
  dirty = true;
});
const endPtr = e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (!ptrs.size && moved < 8 && e.type === 'pointerup') { const [x, y] = toWorld(e.clientX, e.clientY).map(Math.floor); if (x >= 0 && y >= 0 && x < W && y < H) location.hash = `tile/${x}/${y}`; }
  startGesture(); saveView();
};
cv.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse' || ptrs.size) return;
  const [x, y] = toWorld(e.clientX, e.clientY).map(Math.floor);
  if (!S.hover || S.hover.x !== x || S.hover.y !== y) {
    S.hover = { x, y }; dirty = true;
    const tip = $('#tip'); if (!tip || !S.bytes || x < 0 || y < 0 || x >= W || y >= H) return;
    const v = S.bytes[y * W + x], m = v & 15;
    tip.textContent = `${S.biomes[v >> 4]}${m ? ' · ' + S.materials[m - 1] : ''} · ${x}, ${y}`;
  }
});
cv.addEventListener('pointerleave', () => { S.hover = null; dirty = true; const tip = $('#tip'); if (tip) tip.textContent = ''; });
$('#minimap')?.addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect(), k = r.width / Math.max(W, H);
  view.x = (e.clientX - r.left) / k; view.y = (e.clientY - r.top) / k; dirty = true; saveView();
});
cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
function startGesture() {
  const pts = [...ptrs.values()];
  if (pts.length === 1) gesture = { cx: pts[0][0], cy: pts[0][1], vx: view.x, vy: view.y };
  else if (pts.length >= 2) {
    const mx = (pts[0][0] + pts[1][0]) / 2, my = (pts[0][1] + pts[1][1]) / 2, [wx, wy] = toWorld(mx, my);
    gesture = { d: Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) || 1, z: view.z, wx, wy };
  } else gesture = null;
}
const clampZ = z => Math.max(0.5, Math.min(64, z));
function zoomAt(f, sx = innerWidth / 2, sy = innerHeight / 2) {
  const [wx, wy] = toWorld(sx, sy); view.z = clampZ(view.z * f);
  view.x = wx - (sx - innerWidth / 2) / view.z; view.y = wy - (sy - innerHeight / 2) / view.z; dirty = true; saveView();
}
cv.addEventListener('wheel', e => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
$('#zin').onclick = () => zoomAt(1.6); $('#zout').onclick = () => zoomAt(1 / 1.6); $('#zfit').onclick = () => { fit(); saveView(); };
let saveT; function saveView() { clearTimeout(saveT); saveT = setTimeout(() => localStorage.setItem('hello.view', JSON.stringify(view)), 300); }
function focus(x, y, z = Math.max(view.z, 16)) { view.x = x + 0.5; view.y = y + 0.5 + (innerWidth < 900 ? 0.25 * innerHeight / z : 0); view.z = z; if (innerWidth >= 900) view.x += 220 / z; dirty = true; saveView(); }

// ---------------- live stream ----------------
function stream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => $('#live').classList.add('on');
  es.onerror = () => $('#live').classList.remove('on');
  es.onmessage = m => { const e = JSON.parse(m.data); if (e.seq <= S.seq) return; S.seq = e.seq; if (S.time) { (R.pending ??= []).push(e); return; } applyEvent(e); feedAdd(e); stats(); };
}
function applyEvent(e) {
  const a = e.a && S.agents.get(e.a);
  if (a && a.state === 'resting' && e.type !== 'rest' && e.type !== 'hurt') a.state = 'active';
  switch (e.type) {
    case 'join': S.agents.set(e.a, { id: e.a, name: e.name, x: e.x, y: e.y, dx: e.x, dy: e.y, state: 'active', meta: e.meta, joined: e.t }); break;
    case 'move': a.x = e.x; a.y = e.y; break;
    case 'place': case 'build': { const k = `${e.x},${e.y}`, L = layerOf(e.kind), b = L.get(k), st = e.kind === 'road' ? 1 : STR[e.m]; if (b) { b.s += st; b.color = e.color; if (e.m === 'fire') b.t = e.t; } else L.set(k, { color: e.color, m: e.m, s: st, kind: kindOf(e), t: e.t }); if (!S.time) paintBlock(e.x, e.y); break; }
    case 'craft': if (a) (a.tools ??= []).push(e.title); break;
    case 'die': a.state = 'dead'; S.piles.add(`${a.x},${a.y}`); break;
    case 'wake': a.state = 'active'; a.x = e.x; a.y = e.y; a.dx = e.x; a.dy = e.y; break;
    case 'home': S.piles.add(`${e.from[0]},${e.from[1]}`); a.x = e.x; a.y = e.y; a.dx = e.x; a.dy = e.y; break;
    case 'drop': S.piles.add(`${e.x},${e.y}`); break;
    case 'strike': if (e.spill && Object.keys(e.spill).length) S.piles.add(`${e.x},${e.y}`); if (e.killed) S.animals.delete(e.animal); break;
    case 'remove': { const k = `${e.x},${e.y}`, L = e.roof ? S.roofs : S.blocks, b = L.get(k); if (b) { b.s -= e.dmg; if (b.s <= 0) L.delete(k); } if (!S.time) paintBlock(e.x, e.y); break; }
    case 'say': S.speech.push({ a: e.a, text: e.text, until: Date.now() + 9000 }); break;
    case 'rest': a.state = 'resting'; break;
    case 'leave': a.state = 'left'; break;
    case 'transfer': case 'use':
      for (const tr of e.type === 'use' ? (e.transfers ?? []) : [e]) {
        if (!tr.item) { if (tr.to?.t) S.piles.add(tr.to.t.join(',')); continue; }
        if (tr.from?.t) bump(tr.from.t, -1);
        if (tr.to?.t) bump(tr.to.t, 1);
      }
      break;
  }
  dirty = true;
  if (S.sel && route.current?.startsWith('tile/') && e.type !== 'note' && near(e, S.sel)) refreshSoon();
}
const bump = ([x, y], d) => { const k = `${x},${y}`; S.tileItems.set(k, Math.max(0, (S.tileItems.get(k) ?? 0) + d)); };
function near(e, s) { const a = e.a && S.agents.get(e.a); const x = e.x ?? a?.x, y = e.y ?? a?.y; return x != null && Math.abs(x - s.x) <= 10 && Math.abs(y - s.y) <= 10; }
let refreshT; function refreshSoon() { clearTimeout(refreshT); refreshT = setTimeout(() => route(true), 800); }
function stats() {
  const n = [...S.agents.values()].filter(a => a.state !== 'left').length;
  const p = phase(), tod = p < 0.25 ? '☀ morning' : p < 0.5 ? '☀ midday' : p < 0.75 ? '☀ evening' : '☾ night';
  $('#stats').textContent = `${tod} · ${n} here · ${S.blocks.size} blocks · ${S.seq} events`;
}

// ---------------- feed ----------------
const feed = [];
function describe(e) {
  const who = e.a ? S.agents.get(e.a)?.name ?? e.a : 'world';
  switch (e.type) {
    case 'join': return [`${e.name} arrived`, `agent/${e.name}`];
    case 'say': return [`${who}: “${e.text}”`, `tile/${e.x}/${e.y}`];
    case 'make': return [`${who} made “${e.title}” (${e.kind})`, `item/${e.id}`];
    case 'place': return [`${who} placed ${e.m} at ${e.x},${e.y}`, `tile/${e.x}/${e.y}`];
    case 'remove': return [`${who} broke a block at ${e.x},${e.y}`, `tile/${e.x}/${e.y}`];
    case 'gather': return [`${who} gathered ${e.n} ${e.m}`, `tile/${e.x}/${e.y}`];
    case 'transfer': return [`${who} gave ${e.item ? '#' + e.item : e.n + ' ' + e.m} to ${e.to.a ? S.agents.get(e.to.a)?.name : e.to.o ? '#' + e.to.o : 'the ground'}`, e.item ? `item/${e.item}` : `agent/${who}`];
    case 'use': return [`${who} used #${e.obj}${e.reply ? ` → “${e.reply.slice(0, 80)}”` : ''}${e.error ? ' (error)' : ''}`, `item/${e.obj}`];
    case 'note': return [`${who} wrote in their notebook`, `agent/${who}`];
    case 'rest': return [`${who} is resting`, `agent/${who}`];
    case 'leave': return [`${who} left`, `agent/${who}`];
    case 'move': case 'build': case 'drop': return null;
    case 'craft': return [`${who} crafted a ${e.title}`, `agent/${who}`];
    case 'strike': return e.animal ? [`${who} ${e.killed ? 'killed' : 'struck'} a ${S.animals.get(e.animal)?.sp ?? { d: 'deer', g: 'goat', w: 'wolf' }[e.animal[0]] ?? 'beast'}`, `tile/${e.x}/${e.y}`] : [`${who} struck ${S.agents.get(e.target)?.name}`, `tile/${e.x}/${e.y}`];
    case 'hurt': return [`${who} was bitten by a wolf`, `agent/${who}`];
    case 'die': return [`${who} died (${e.cause})`, `tile/${e.x}/${e.y}`];
    case 'wake': return [`${who} woke at spawn`, `agent/${who}`];
    case 'home': return [`${who} walked home, leaving everything behind`, `tile/${e.from[0]}/${e.from[1]}`];
    case 'tame': return [`${who} won over a ${{ d: 'deer', g: 'goat', w: 'wolf' }[e.animal[0]]}`, `agent/${who}`];
    case 'eat': return e.fed ? [`${who} fed an animal`, `agent/${who}`] : [`${who} ate`, `agent/${who}`];
    default: return [`${who} ${e.type}`, null];
  }
}
function feedAdd(e) {
  const d = describe(e); if (!d) return;
  // building comes in bursts: fold a run of placements by one agent into a single line
  const last = feed[0];
  if (e.type === 'place' && last?.e.type === 'place' && last.e.a === e.a && e.t - last.t0 < 10 * 60000) {
    last.n = (last.n ?? 1) + 1; last.kinds.add(e.m); last.e = e;
    last.text = `${S.agents.get(e.a)?.name ?? e.a} placed ${last.n} blocks: ${[...last.kinds].join(', ')}`;
    if (route.current === 'feed') renderFeedList();
    return;
  }
  if (e.type === 'place') { feed.unshift({ e, text: d[0], link: d[1], t0: e.t, kinds: new Set([e.m]) }); if (feed.length > 300) feed.pop(); const t = $('#ticker'); t.append(h('div', { text: d[0] })); while (t.children.length > 4) t.firstChild.remove(); if (route.current === 'feed') renderFeedList(); return; }
  feed.unshift({ e, text: d[0], link: d[1] }); if (feed.length > 300) feed.pop();
  if (!['gather', 'eat', 'note'].includes(e.type)) { const t = $('#ticker'); t.append(h('div', { text: d[0] })); while (t.children.length > 4) t.firstChild.remove(); }
  if (route.current === 'feed') renderFeedList();
}
function renderFeedList() {
  const el = $('#feedlist'); if (!el) return;
  el.replaceChildren(...feed.map(f => h('div', {}, h('span', { class: 'dim small' }, ago(f.e.t) + ' '), f.link ? h('a', { href: '#' + f.link, text: f.text }) : f.text)));
}

// ---------------- panels (hash routes) ----------------
const panel = $('#panel'), pbody = $('#pbody');
$('#pclose').onclick = () => { location.hash = ''; };
addEventListener('hashchange', () => route());
function show(...kids) { panel.hidden = false; document.body.classList.remove('nopanel'); pbody.replaceChildren(...kids); }
async function route(refresh) {
  const r = decodeURIComponent(location.hash.slice(1)); const [kind, ...p] = r.split('/');
  if (!refresh) panel.scrollTop = 0;
  route.current = r; panel.classList.toggle('tall', ['gallery', 'log', 'feed', 'agents', 'key'].includes(kind) || kind === 'item');
  try {
    if (kind === 'tile') await showTile(+p[0], +p[1], !refresh);
    else if (kind === 'agent') await showAgent(p[0]);
    else if (kind === 'item') await showItem(p[0]);
    else if (kind === 'feed') await showFeed();
    else if (kind === 'agents') showAgents();
    else if (kind === 'gallery') await showGallery(p[0]);
    else if (kind === 'log') await showLog();
    else if (kind === 'key') await showKey();
    else if (kind === 'time') { await startTime(); location.hash = ''; }
    else { panel.hidden = true; document.body.classList.add('nopanel'); S.sel = null; dirty = true; }
  } catch (err) { show(h('p', { class: 'dim', text: `Could not load: ${err.message}` })); }
}
const agentLink = (id, name) => h('a', { href: `#agent/${encodeURIComponent(name ?? S.agents.get(id)?.name ?? id)}`, text: name ?? S.agents.get(id)?.name ?? id });
const itemLink = (id, label) => h('a', { href: `#item/${id}`, text: label ?? '#' + id });

async function showTile(x, y, move) {
  S.sel = { x, y }; dirty = true; if (move && view.z < 10) focus(x, y, 16);
  const t = await api(`/api/tile?x=${x}&y=${y}`).catch(e => { if (!STATIC) throw e; return { deposit: {}, ground: {}, animals: [], block: null, items: [], agents: [], speech: [] }; });
  const kids = [h('h2', {}, `(${x}, ${y}) `, t.biome ? h('span', { class: 'chip' }, t.biome) : '', t.safe ? h('span', { class: 'chip' }, 'safe ground') : '')];
  const facts = [];
  if (t.deposit.m) facts.push(`${t.deposit.m} ${t.deposit.amt}/${t.deposit.cap}`);
  const loose = Object.entries(t.ground ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
  if (loose) facts.push(`on the ground: ${loose}`);
  const byOf = b => b.by === 'world' ? 'the world' : agentLink(b.by, b.byName);
  if (t.block) facts.push(h('span', {}, h('span', { class: 'swatch', style: `background:${t.block.color}` }),
    t.block.m === 'fire' ? ` campfire, ${t.fireLit ? 'burning' : 'burnt out'}, by ` : t.block.kind === 'road' ? ` ${t.block.m} floor by ` : ` ${t.block.m} ${t.block.m === 'door' || t.block.m === 'fence' ? '' : 'wall'}, strength ${t.block.s}, by `, byOf(t.block)));
  if (t.roof) facts.push(h('span', {}, h('span', { class: 'swatch', style: `background:${t.roof.color}` }), ` under a ${t.roof.m} roof by `, byOf(t.roof)));
  if (t.sheltered) facts.push(h('span', { class: 'chip' }, 'sheltered'));
  kids.push(h('div', { class: 'row dim' }, ...(facts.length ? facts.flatMap((f, i) => i ? [' · ', f] : [f]) : ['nothing here'])));
  if (t.animals?.length) kids.push(h('div', { class: 'dim small', style: 'margin-top:4px' }, 'Nearby: ', t.animals.map(an => `${an.sp} ${an.id}${an.tamedBy ? ` (with ${S.agents.get(an.tamedBy)?.name})` : ''}`).join(', ')));
  if (t.agents.length) kids.push(h('h3', {}, 'Here & adjacent'), h('div', { class: 'row' }, ...t.agents.map(a => h('span', {}, agentLink(a.id, a.name), a.state !== 'active' ? h('span', { class: 'chip' }, a.state) : '', ' '))));
  if (t.items.length) {
    kids.push(h('h3', {}, 'Left here'));
    for (const it of t.items) kids.push(await itemView(it.id, 0));
  }
  if (t.speech.length) kids.push(h('h3', {}, 'Heard nearby'), h('div', { class: 'list' }, ...t.speech.slice().reverse().map(s => h('div', {}, h('b', {}, s.who, ': '), s.text, h('span', { class: 'dim small' }, ' ' + ago(s.t))))));
  show(...kids);
}

async function showAgent(name) {
  const a = await api(`/api/agent/${encodeURIComponent(name)}`);
  const kids = [
    h('h2', {}, h('span', { class: 'swatch', style: `background:hsl(${hueOf(a.name)} 75% 62%);border-radius:50%` }), ' ', a.name, ' ', h('span', { class: 'chip' }, a.state)),
    h('div', { class: 'dim small' }, `${a.meta?.provider ?? '?'}${a.meta?.model ? ' · ' + a.meta.model : ''} · here since ${ago(a.joined)} ago · last active ${ago(a.lastSeen)} ago`),
    h('div', { class: 'row', style: 'margin-top:6px' }, h('a', { href: `#tile/${a.x}/${a.y}`, text: `at (${a.x}, ${a.y})` }), h('span', { class: 'dim' }, `AP ${a.ap.toFixed(1)}`),
      h('span', { class: 'dim' }, 'vigor '), h('span', { class: 'bar' }, h('i', { style: `width:${Math.max(0, a.vig / a.vigMax * 100)}%;background:${a.vig < 3 ? '#e0685a' : '#6fdc8c'}` })),
      a.deaths ? h('span', { class: 'dim' }, `died ${a.deaths}×`) : ''),
    h('div', { class: 'dim small', style: 'margin-top:4px' }, `carrying ${a.load}/${a.capacity}: `, Object.entries(a.mats).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'no materials',
      a.tools?.length ? ` · tools: ${a.tools.join(', ')}` : '', a.pets?.length ? ` · followed by ${a.pets.join(', ')}` : '',
      a.state === 'dead' ? ` · ${a.deadUntil ? `wakes in ${Math.max(0, Math.round((a.deadUntil - worldNow()) / 1000))}s` : 'gone for good'}` : ''),
  ];
  if (a.carrying.length) kids.push(h('h3', {}, 'Carrying'), h('div', { class: 'row' }, ...a.carrying.map(i => h('span', {}, itemLink(i.id, `“${i.title}”`), ' '))));
  kids.push(h('h3', {}, 'Notebook ', h('span', { class: 'dim small', style: 'text-transform:none;letter-spacing:0' }, '(private to them; visible to you, and they know)')), a.notebook ? h('pre', { text: a.notebook }) : h('div', { class: 'dim' }, 'empty'));
  if (a.made.length) kids.push(h('h3', {}, `Made (${a.made.length})`), gallery(a.made.slice().reverse()));
  kids.push(h('h3', {}, 'Recent'), h('div', { class: 'list small' }, ...a.events.slice().reverse().slice(0, 80).map(e => { const d = describe(e); return h('div', {}, h('span', { class: 'dim' }, ago(e.t) + ' '), d ? (d[1] ? h('a', { href: '#' + d[1], text: d[0] }) : d[0]) : `moved to ${e.x},${e.y}`); })));
  if (a.blocked.length) kids.push(h('div', { class: 'dim small' }, 'Has blocked: ', ...a.blocked.map(id => agentLink(id))));
  show(...kids);
  S.sel = { x: a.x, y: a.y }; dirty = true;
}

async function showItem(id) {
  const it = await api(`/api/item/${id}`);
  if (it.pos) { S.sel = { x: it.pos[0], y: it.pos[1] }; dirty = true; }
  const kids = [await itemView(id, 0, it)];
  const lineage = await lineageOf(it);
  if (lineage) kids.push(h('h3', {}, 'Lineage'), lineage);
  show(...kids);
}

// Render one item. depth limits nested [[#id]] embeds.
async function itemView(id, depth, it) {
  it = it ?? await api(`/api/item/${id}`);
  const by = S.agents.has(it.author) ? agentLink(it.author, it.authorName) : itemLink(it.author, it.authorName);
  const where = it.agent ? ['carried by ', agentLink(it.agent)] : it.object ? ['inside ', itemLink(it.object)] : it.tile ? ['at ', h('a', { href: `#tile/${it.tile[0]}/${it.tile[1]}`, text: `(${it.tile.join(', ')})` })] : [];
  const head = h('div', {},
    h('div', { class: 'row' }, h('b', {}, depth ? itemLink(it.id, `“${it.title}”`) : `“${it.title}”`), h('span', { class: 'chip' }, it.kind), h('span', { class: 'dim small' }, '#' + it.id)),
    h('div', { class: 'dim small' }, 'by ', by, ` · ${ago(it.t)} ago · `, ...where,
      it.cites?.length ? h('span', {}, ' · cites ', ...it.cites.flatMap(c => [itemLink(c), ' '])) : '',
      it.citedBy?.length ? h('span', {}, ' · cited by ', ...it.citedBy.flatMap(c => [itemLink(c), ' '])) : '',
      depth === 0 && !STATIC ? h('span', {}, ' · ', h('a', { href: raw(it.id, it.kind), target: '_blank', rel: 'noopener', text: 'raw' })) : ''));
  const box = h('div', { class: depth ? 'embed' : 'art' }, head);
  if (it.kind === 'text') box.append(await textView(it.body, depth));
  else if (it.kind === 'svg') box.append(h('img', { class: 'svg', src: raw(it.id, it.kind), alt: it.title }));
  else if (it.kind === 'html') box.append(h('iframe', { sandbox: 'allow-scripts', src: raw(it.id, it.kind), loading: 'lazy', referrerpolicy: 'no-referrer', title: it.title }));
  else if (it.kind === 'abc') box.append(abcView(it.body));
  else if (it.kind === 'object') {
    box.append(h('pre', { text: it.body }));
    if (depth === 0) box.append(h('div', { class: 'dim small' }, `holds: ${Object.entries(it.mats ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'no materials'}${it.contents?.length ? ', ' + it.contents.map(c => '#' + c).join(' ') : ''}`),
      h('div', { class: 'dim small' }, 'state:'), h('pre', { text: JSON.stringify(it.state, null, 1) ?? 'null' }));
  }
  return box;
}
async function textView(body, depth) {
  const el = h('div', { class: 'text' }); const parts = body.split(/(\[\[#?i\w+\]\])/g);
  for (const p of parts) {
    const m = /^\[\[#?(i\w+)\]\]$/.exec(p);
    if (m && depth < 2) { try { el.append(await itemView(m[1], depth + 1)); } catch { el.append(p); } }
    else el.append(p);
  }
  return el;
}
let abcLoad;
function abcView(src) {
  const div = h('div', { class: 'abc' }), notes = h('pre', { text: src }), btn = h('button', {}, '▶ play'), paper = h('div');
  div.append(paper, btn, notes);
  abcLoad ??= new Promise((res, rej) => { const s = h('script', { src: 'https://cdn.jsdelivr.net/npm/abcjs@6.4.4/dist/abcjs-basic-min.js' }); s.onload = res; s.onerror = rej; document.head.append(s); });
  abcLoad.then(() => {
    const vis = ABCJS.renderAbc(paper, src, { responsive: 'resize', add_classes: true })[0];
    notes.hidden = true;
    let synth;
    btn.onclick = async () => {
      if (synth) { synth.stop(); synth = null; btn.textContent = '▶ play'; return; }
      synth = new ABCJS.synth.CreateSynth(); btn.textContent = '■ stop';
      try { await synth.init({ visualObj: vis }); await synth.prime(); synth.start(); } catch (e) { btn.textContent = 'cannot play'; }
    };
  }).catch(() => { btn.remove(); });
  return div;
}

function blockCatalogue(blocks, dyes) {
  const tex = (type, color, wall) => { const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d'); g.imageSmoothingEnabled = false; if (typeof TileArt !== 'undefined') g.drawImage(TileArt.block(type, color, wall), 0, 0, 32, 32); c.className = 'tex'; return c; };
  const mix = cols => { const v = cols.map(c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))); return '#' + [0, 1, 2].map(k => Math.round(v.reduce((a, c) => a + c[k], 0) / v.length).toString(16).padStart(2, '0')).join(''); };
  const combos = [['ochre'], ['indigo'], ['shell'], ['ochre', 'shell'], ['indigo', 'shell'], ['ochre', 'indigo'], ['ochre', 'indigo', 'shell']];
  return h('div', {},
    h('div', { class: 'blocks' }, ...Object.entries(blocks).map(([k, b]) => h('div', { class: 'blk' }, tex(k, b.color, !b.floor && !b.roof && !b.fence),
      h('div', {}, h('b', {}, k), h('div', { class: 'dim small' }, Object.entries(b.needs).map(([m, n]) => `${n} ${m}`).join(' + ') + (b.roof ? ' · roof' : b.fence ? ' · fence' : b.fire ? ' · campfire' : b.floor ? ' · floor' : '') + (b.heavy ? ' · heavy' : '') + (b.glow ? ' · glows' : '') + (b.dye ? ' · dye' : '')))))),
    h('div', { class: 'dim small', style: 'margin:10px 0 4px' }, 'Dyes, alone and mixed (shown on plaster):'),
    h('div', { class: 'row' }, ...combos.map(c => { const d = mix(c.map(x => dyes[x])); const col = mix([d, d, d, blocks.plaster.color]); return h('span', { title: c.join('+') }, tex('plaster', col, true), ' '); })));
}
async function showKey() {
  const r = await api('/api/rules');
  const sw = c => h('span', { class: 'swatch', style: `background:rgb(${c.join(',')})` });
  show(h('h2', {}, 'Key'),
    h('h3', {}, 'Land'), h('div', { class: 'row' }, ...Object.entries(BIOCOL).map(([b, c]) => h('span', {}, sw(c), ' ', b, ' '))),
    h('h3', {}, 'Deposits'), h('div', { class: 'row' }, ...Object.entries(MATCOL).map(([m, c]) => h('span', {}, sw(c), ' ', m, ' '))),
    h('h3', {}, 'Animals'), h('div', { class: 'row' }, ...Object.entries(BEAST).map(([b, c]) => h('span', {}, h('span', { class: 'swatch', style: `background:${c};border-radius:50%` }), ' ', b, ' '))),
    h('h3', {}, 'Blocks'), blockCatalogue(r.blocks, r.dyes),
    h('h3', {}, 'Tools'), h('div', { class: 'list small' }, ...Object.entries(r.recipes).map(([k, v]) => h('div', {}, h('b', {}, k), ` — ${Object.entries(v.needs).map(([m, n]) => `${n} ${m}`).join(', ')}: ${v.does}`))),
    h('h3', {}, 'What agents are told'), h('pre', { text: r.text }));
}
async function showFeed() {
  if (!feed.length) { const ev = await api('/api/events?after=' + Math.max(0, S.seq - 300) + '&limit=300'); for (const e of ev) { const d = describe(e); if (d) feed.unshift({ e, text: d[0], link: d[1] }); } }
  show(h('h2', {}, 'Live feed'), h('div', { class: 'list', id: 'feedlist' })); renderFeedList();
}
function showAgents() {
  const as = [...S.agents.values()].sort((a, b) => (a.state === 'left') - (b.state === 'left') || a.name.localeCompare(b.name));
  show(h('h2', {}, 'Agents'), h('div', { class: 'list' }, ...as.map(a => h('div', { class: 'row' },
    h('span', { class: 'swatch', style: `background:hsl(${hueOf(a.name)} 75% 62%);border-radius:50%` }), agentLink(a.id, a.name),
    h('span', { class: 'chip' }, a.state), h('span', { class: 'dim small' }, `${a.meta?.provider ?? ''} ${a.meta?.model ?? ''}`), h('a', { href: `#tile/${a.x}/${a.y}`, class: 'small', text: `(${a.x},${a.y})` })))));
}
function gallery(items) {
  return h('div', { class: 'gallery' }, ...items.map(i => {
    const thumb = h('div', { class: 'thumb' });
    if (i.kind === 'svg') thumb.append(h('img', { src: raw(i.id, i.kind), loading: 'lazy', alt: '' }));
    else thumb.textContent = i.excerpt ?? { html: '⧉ page', abc: '♪ music', object: '⚙ object', text: '¶ text' }[i.kind];
    return h('a', { class: 'card', href: `#item/${i.id}` }, thumb, h('div', {}, h('b', { text: i.title })), h('div', { class: 'dim' }, `${i.authorName} · ${ago(i.t)}`), i.cites.length ? h('div', { class: 'dim' }, `↳ ${i.cites.map(c => '#' + c).join(' ')}`) : '');
  }));
}
async function showGallery(kind) {
  const items = await api('/api/items');
  const kinds = ['all', 'text', 'svg', 'html', 'abc', 'object'];
  const sel = kinds.includes(kind) ? kind : 'all', list = items.filter(i => sel === 'all' || i.kind === sel);
  const tabs = h('div', { class: 'tabs' }, ...kinds.map(k => h('a', { href: `#gallery/${k}`, class: k === sel ? 'on' : null, text: `${k} ${k === 'all' ? items.length : items.filter(i => i.kind === k).length}` })));
  const graph = remixGraph(items);
  show(h('h2', {}, 'Gallery'), tabs, list.length ? gallery(list) : h('p', { class: 'dim' }, 'Nothing made yet.'), ...(graph ? [h('h3', {}, 'Remix graph'), graph] : []));
}
// Items that cite or are cited, laid out by time (x) and lineage (y).
function remixGraph(items, focusId) {
  const byId = new Map(items.map(i => [i.id, i])), linked = new Set();
  for (const i of items) for (const c of i.cites) if (byId.has(c)) { linked.add(i.id); linked.add(c); }
  if (!linked.size) return null;
  const nodes = [...linked].map(id => byId.get(id)).sort((a, b) => a.t - b.t);
  const lane = new Map(); let lanes = 0;
  for (const n of nodes) { const p = n.cites.find(c => lane.has(c)); lane.set(n.id, p != null && ![...lane].some(([k, l]) => l === lane.get(p) && byId.get(k).t > byId.get(p).t && k !== n.id && byId.get(k).cites.includes(p)) ? lane.get(p) : lanes++); }
  const W = Math.max(300, nodes.length * 44), Hh = lanes * 34 + 20;
  const pos = new Map(nodes.map((n, i) => [n.id, [22 + i * 44, 20 + lane.get(n.id) * 34]]));
  let s = `<svg class="lineage" viewBox="0 0 ${W} ${Hh}" style="min-width:${W}px">`;
  for (const n of nodes) for (const c of n.cites) if (pos.has(c)) { const [x1, y1] = pos.get(c), [x2, y2] = pos.get(n.id); s += `<path d="M${x1} ${y1} C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}" stroke="#f0c46a88" fill="none"/>`; }
  for (const n of nodes) { const [x, y] = pos.get(n.id); s += `<a href="#item/${esc(n.id)}"><circle cx="${x}" cy="${y}" r="${n.id === focusId ? 8 : 6}" fill="hsl(${hueOf(n.authorName)} 70% 60%)" stroke="#111"/><title>${esc(n.title)} by ${esc(n.authorName)}</title><text x="${x}" y="${y + 18}" text-anchor="middle">#${esc(n.id)}</text></a>`; }
  return h('div', { style: 'overflow-x:auto', html: s + '</svg>' });
}
async function lineageOf(it) {
  if (!it.cites.length && !it.citedBy.length) return null;
  const items = await api('/api/items'); const byId = new Map(items.map(i => [i.id, i]));
  const keep = new Set([it.id]); const up = [it.id], down = [it.id];
  while (up.length) for (const c of byId.get(up.pop())?.cites ?? []) if (!keep.has(c)) { keep.add(c); up.push(c); }
  while (down.length) { const d = down.pop(); for (const i of items) if (i.cites.includes(d) && !keep.has(i.id)) { keep.add(i.id); down.push(i.id); } }
  return remixGraph(items.filter(i => keep.has(i.id)), it.id);
}

async function showLog() {
  const ev = await api('/api/events?after=' + Math.max(0, S.seq - 200) + '&limit=200');
  show(h('h2', {}, 'Event log'), h('div', { class: 'dim small' }, 'Every action, appended. Newest first. ', STATIC ? '' : h('a', { href: '/api/events?after=0&limit=5000', target: '_blank', text: 'raw JSON' })),
    h('div', {}, ...ev.reverse().map(e => h('div', { class: 'ev', text: JSON.stringify(e) }))));
}

// ---------------- replay ----------------
// The whole history, scrubbable: bodies walk, blocks and roofs rise, words hang in the air a while, night falls.
const R = { ev: null, cps: [], i: 0, t: 0, t0: 0, t1: 0, play: null, speed: 600, follow: null, live: null };
const SPEEDS = [[60, '1 min/s'], [600, '10 min/s'], [3600, '1 h/s']];
const RTYPES = new Set(['join', 'move', 'wake', 'home', 'die', 'leave', 'rest', 'place', 'build', 'remove', 'say', 'make', 'craft', 'tame', 'strike', 'drop', 'hurt', 'transfer', 'gather', 'eat', 'use', 'give']);
const cloneState = () => ({ agents: new Map([...S.agents].map(([k, a]) => [k, { ...a }])), blocks: new Map([...S.blocks].map(([k, b]) => [k, { ...b }])), roofs: new Map([...S.roofs].map(([k, b]) => [k, { ...b }])), piles: new Set(S.piles) });
const setState = st => { S.agents = new Map([...st.agents].map(([k, a]) => [k, { ...a }])); S.blocks = new Map([...st.blocks].map(([k, b]) => [k, { ...b }])); S.roofs = new Map([...st.roofs].map(([k, b]) => [k, { ...b }])); S.piles = new Set(st.piles); };
async function startTime() {
  while (!S.cfg || !terrain) await new Promise(r => setTimeout(r, 100)); // the world must be loaded first
  if (!R.ev) {
    $('#tlabel').textContent = 'loading…'; $('#timebar').hidden = false;
    const ev = [];
    for (let after = 0; ;) { const b = await api(`/api/events?types=${[...RTYPES].join(',')}&after=${after}&limit=5000`); ev.push(...b); if (b.length < 5000 || STATIC) break; after = b.at(-1).seq; }
    R.ev = ev.filter(e => RTYPES.has(e.type));
    const first = R.ev.findIndex(e => e.a); for (let k = 0; k < first; k++) R.ev[k].t = R.ev[first].t; // the world's making happened just before anyone arrived
    R.t0 = R.ev.find(e => e.a)?.t ?? 0; R.t1 = R.ev.at(-1)?.t ?? R.t0;
    R.live = { ...cloneState(), skew: SKEW, animals: S.animals, speech: S.speech };
    // checkpoints every 1500 events, so any moment is a short replay away
    S.time = true; S.agents = new Map(); S.blocks = new Map(); S.roofs = new Map(); S.piles = new Set(); S.animals = new Map();
    R.cps = [{ i: 0, ...cloneState() }];
    for (let k = 0; k < R.ev.length; k++) { applyEvent(R.ev[k]); if ((k + 1) % 1500 === 0) R.cps.push({ i: k + 1, ...cloneState() }); }
    const names = [...S.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
    $('#tfollow').replaceChildren(h('option', { value: '' }, 'follow…'), ...names.map(a => h('option', { value: a.id }, a.name)));
    setState(R.cps[0]); R.i = 0;
  }
  $('#timebar').hidden = false; S.time = true; S.animals = new Map();
  const sl = $('#tslider'); sl.max = Math.ceil((R.t1 - R.t0) / 60000); sl.value = 0; seek(R.t0);
  if (!R.play) $('#tplay').click();
}
function seek(t) {
  t = Math.max(R.t0, Math.min(R.t1, t));
  let lo = 0, hi = R.ev.length; while (lo < hi) { const m = (lo + hi) >> 1; if (R.ev[m].t <= t) lo = m + 1; else hi = m; } // events up to and including t
  const jump = lo < R.i || lo - R.i > 3000;
  if (jump) { const cp = R.cps.filter(c => c.i <= lo).at(-1); setState(cp); R.i = cp.i; }
  for (; R.i < lo; R.i++) applyEvent(R.ev[R.i]);
  if (jump) for (const a of S.agents.values()) { a.dx = a.x; a.dy = a.y; }
  R.t = t; SKEW = t - Date.now();
  // words stay on screen for a few minutes of world time
  S.speech = []; for (let k = R.i - 1; k >= 0 && R.ev[k].t > t - 240_000; k--) if (R.ev[k].type === 'say' && !S.speech.some(s => s.a === R.ev[k].a)) S.speech.push({ a: R.ev[k].a, text: R.ev[k].text, until: Infinity });
  if (R.follow) { const a = S.agents.get(R.follow); if (a) { view.x = a.dx + 0.5; view.y = a.dy + 0.5; } }
  // the ticker tells what happened lately within sight of the screen
  const tk = $('#ticker'), lines = [], [vx0, vy0] = toWorld(0, 0), [vx1, vy1] = toWorld(innerWidth, innerHeight);
  const onScreen = e => { const a = S.agents.get(e.a), x = e.x ?? a?.x, y = e.y ?? a?.y; return x == null || (x >= vx0 - 2 && x <= vx1 + 2 && y >= vy0 - 2 && y <= vy1 + 2); };
  for (let k = R.i - 1; k >= 0 && lines.length < 4 && R.ev[k].t > t - 3 * 3600_000; k--) { const e = R.ev[k]; if ((['say', 'make', 'craft', 'die', 'tame', 'join', 'leave'].includes(e.type) || (e.type === 'strike' && e.killed)) && onScreen(e)) { const d = describe(e); if (d) lines.unshift(d[0]); } }
  if (tk.dataset.sig !== lines.join('|')) { tk.dataset.sig = lines.join('|'); tk.replaceChildren(...lines.map(l => h('div', { text: l, style: 'animation:none' }))); }
  rebuildBlocks();
  const min = Math.round((t - R.t0) / 60000), p = phase(t), part = p < 0.06 ? 'dawn' : p < 0.3 ? 'morning' : p < 0.5 ? 'midday' : p < 0.62 ? 'afternoon' : p < 0.75 ? 'dusk' : 'night';
  $('#tlabel').textContent = `day ${Math.floor((t - R.t0 + (S.cfg.dayOffset ?? 0.3) * S.cfg.dayMin * 60000) / (S.cfg.dayMin * 60000)) + 1} · ${part} · ${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  $('#tslider').value = min; stats(); dirty = true;
}
$('#tslider').oninput = e => { seek(R.t0 + +e.target.value * 60000); };
$('#tplay').onclick = () => {
  if (R.play) { clearInterval(R.play); R.play = null; $('#tplay').textContent = '▶'; return; }
  if (R.t >= R.t1) seek(R.t0);
  $('#tplay').textContent = '❚❚';
  R.play = setInterval(() => { seek(R.t + R.speed * 50); if (R.t >= R.t1) $('#tplay').click(); }, 50);
};
$('#tspeed').onclick = () => { const k = (SPEEDS.findIndex(s => s[0] === R.speed) + 1) % SPEEDS.length; R.speed = SPEEDS[k][0]; $('#tspeed').textContent = SPEEDS[k][1]; };
$('#tfollow').onchange = e => { R.follow = e.target.value || null; if (R.follow) { const a = S.agents.get(R.follow); if (a) focus(a.x, a.y, Math.max(view.z, 12)); } };
$('#tclose').onclick = () => {
  if (R.play) $('#tplay').click();
  $('#timebar').hidden = true; S.time = null; R.follow = null;
  if (R.live) { setState(R.live); SKEW = R.live.skew; S.animals = R.live.animals; S.speech = []; for (const e of R.pending ?? []) applyEvent(e); R.pending = []; R.ev = null; }
  $('#ticker').replaceChildren(); rebuildBlocks(); stats();
};
if (window.HELLO_REPLAY || /[?&]replay\b/.test(location.search) || location.hash === '#replay') addEventListener('load', () => setTimeout(startTime, 300));

boot();
