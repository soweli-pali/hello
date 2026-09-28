// Up-close art: every tile drawn as a tile, with procedural texture. Cached in 32×32-tile chunks at 16px per tile.
'use strict';
const TileArt = (() => {
  const PX = 16, CH = 32;
  let W, H, bytes, elev, biomes, materials, colors;
  const chunks = new Map(), blockCache = new Map();
  const hh = (x, y, s = 0) => { let v = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s + 7, 1442695041)) | 0; v = Math.imul(v ^ (v >>> 13), 1274126177); return ((v ^ (v >>> 16)) >>> 0) / 4294967296; };
  const rgb = (c, k = 1, a = 1) => `rgba(${Math.round(Math.min(255, c[0] * k))},${Math.round(Math.min(255, c[1] * k))},${Math.round(Math.min(255, c[2] * k))},${a})`;
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

  function init(o) { ({ W, H, bytes, elev, biomes, materials, colors } = o); chunks.clear(); }
  const B = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 'sea' : biomes[bytes[y * W + x] >> 4];
  const E = (x, y) => elev[Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))];
  const level = (x, y) => Math.floor(E(x, y) / 9); // terraces: elevation in steps, so the ground reads as tiles

  // ---- terrain: one tile ----
  function tile(g, x, y, px, py) {
    const b = B(x, y), r = k => hh(x, y, k), base = colors.biome[b], water = b === 'sea' || b === 'river';
    let c = base;
    if (b === 'sea') { const d = Math.min(1, E(x, y) / 60); c = [14 + 34 * d * d, 32 + 62 * d * d, 56 + 66 * d * d]; }
    const L = level(x, y), lit = water ? 1 : 1 + Math.max(-0.12, Math.min(0.12, (level(x - 1, y - 1) - L) * -0.06 + (L - level(x + 1, y + 1)) * 0.06));
    g.fillStyle = rgb(c, lit * (0.97 + r(1) * 0.06)); g.fillRect(px, py, PX, PX);
    const dot = (dx, dy, s, col) => { g.fillStyle = col; g.fillRect(px + dx, py + dy, s, s); };
    switch (b) {
      case 'meadow':
        for (let i = 0; i < 5; i++) { const gx = Math.floor(r(10 + i) * 14) + 1, gy = Math.floor(r(20 + i) * 12) + 3; g.fillStyle = rgb(base, i % 2 ? 1.25 : 0.8); g.fillRect(px + gx, py + gy, 1, 2); g.fillRect(px + gx + 1, py + gy - 1, 1, 2); }
        if (r(3) < 0.25) dot(Math.floor(r(4) * 12) + 2, Math.floor(r(5) * 12) + 2, 1, r(6) < 0.5 ? '#f1ecd6' : '#e8c95a');
        break;
      case 'forest': {
        const n = r(3) < 0.5 ? 1 : 2;
        for (let i = 0; i < n; i++) {
          const cx = px + 4 + Math.floor(r(30 + i) * 8), cy = py + 4 + Math.floor(r(40 + i) * 8), rad = 4 + r(50 + i) * 2.5;
          g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.arc(cx + 1.5, cy + 2, rad, 0, 7); g.fill();
          g.fillStyle = rgb(base, 0.78); g.beginPath(); g.arc(cx, cy, rad, 0, 7); g.fill();
          g.fillStyle = rgb(base, 1.18); g.beginPath(); g.arc(cx - rad * 0.3, cy - rad * 0.35, rad * 0.45, 0, 7); g.fill();
        }
        break;
      }
      case 'marsh':
        g.fillStyle = 'rgba(40,74,92,.55)'; g.beginPath(); g.ellipse(px + 5 + r(3) * 6, py + 6 + r(4) * 5, 3 + r(5) * 2, 1.6, 0, 0, 7); g.fill();
        for (let i = 0; i < 4; i++) { g.fillStyle = rgb(base, 1.3); g.fillRect(px + 2 + Math.floor(r(60 + i) * 12), py + 5 + Math.floor(r(70 + i) * 8), 1, 4); }
        break;
      case 'desert': case 'beach':
        g.strokeStyle = rgb(base, 1.1, 0.8); g.lineWidth = 1;
        for (let i = 0; i < 2; i++) { const yy = py + 4 + i * 6 + r(80 + i) * 3; g.beginPath(); g.moveTo(px + 1, yy); g.quadraticCurveTo(px + 8, yy - 2.5, px + 15, yy); g.stroke(); }
        for (let i = 0; i < 3; i++) dot(Math.floor(r(90 + i) * 15), Math.floor(r(95 + i) * 15), 1, rgb(base, 0.85));
        break;
      case 'tundra':
        g.fillStyle = 'rgba(240,246,250,.75)'; g.beginPath(); g.ellipse(px + 4 + r(3) * 8, py + 4 + r(4) * 8, 3 + r(5) * 3, 2 + r(6) * 2, 0, 0, 7); g.fill();
        for (let i = 0; i < 3; i++) { g.fillStyle = rgb(base, 0.75); g.fillRect(px + 1 + Math.floor(r(60 + i) * 14), py + 2 + Math.floor(r(70 + i) * 12), 1, 2); }
        break;
      case 'mountain':
        g.strokeStyle = rgb(base, 0.7); g.lineWidth = 1; g.beginPath();
        g.moveTo(px + 2 + r(3) * 4, py + 3); g.lineTo(px + 7 + r(4) * 3, py + 8 + r(5) * 3); g.lineTo(px + 13, py + 6 + r(6) * 6); g.stroke();
        g.fillStyle = rgb(base, 1.2); g.beginPath(); g.moveTo(px + 3, py + 13); g.lineTo(px + 6, py + 9); g.lineTo(px + 9, py + 13); g.fill();
        break;
      case 'peak':
        g.fillStyle = 'rgba(150,170,200,.35)'; g.beginPath(); g.moveTo(px + 8, py + 2); g.lineTo(px + 15, py + 14); g.lineTo(px + 8, py + 14); g.fill();
        dot(Math.floor(r(3) * 12) + 2, Math.floor(r(4) * 12) + 2, 1, '#ffffff');
        break;
      case 'sea':
        if (r(3) < 0.35) { g.strokeStyle = 'rgba(160,200,230,.18)'; g.beginPath(); const yy = py + 5 + r(4) * 8, xx = px + r(5) * 8; g.moveTo(xx, yy); g.quadraticCurveTo(xx + 3, yy - 2, xx + 6, yy); g.stroke(); }
        break;
      case 'river':
        g.strokeStyle = 'rgba(190,225,240,.28)'; g.beginPath(); for (let i = 0; i < 2; i++) { const yy = py + 4 + i * 7 + r(6 + i) * 2; g.moveTo(px + 2, yy); g.lineTo(px + 8 + r(8) * 5, yy); } g.stroke();
        break;
    }
    // shore: a pale lip where water meets land
    if (water) {
      g.fillStyle = 'rgba(220,235,235,.35)';
      if (!isW(x, y - 1)) g.fillRect(px, py, PX, 2); if (!isW(x, y + 1)) g.fillRect(px, py + PX - 2, PX, 2);
      if (!isW(x - 1, y)) g.fillRect(px, py, 2, PX); if (!isW(x + 1, y)) g.fillRect(px + PX - 2, py, 2, PX);
    } else {
      // cliffs: where the land steps down to the south or east, draw the drop
      const dS = L - level(x, y + 1), dE = L - level(x + 1, y);
      if (dS > 0 && !isW(x, y + 1)) { g.fillStyle = `rgba(0,0,0,${Math.min(0.45, 0.18 * dS)})`; g.fillRect(px, py + PX - 3, PX, 3); }
      if (dE > 0 && !isW(x + 1, y)) { g.fillStyle = `rgba(0,0,0,${Math.min(0.3, 0.12 * dE)})`; g.fillRect(px + PX - 2, py, 2, PX); }
      if (L - level(x, y - 1) < 0) { g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(px, py, PX, 1); }
    }
    // deposits: the fine things drawn plainly; everyday stuff drawn faintly, and not at all where the ground itself is that stuff
    const m = bytes[y * W + x] & 15;
    if (m) { const mat = materials[m - 1], common = ['stone', 'wood', 'clay', 'sand', 'fiber', 'food'].includes(mat);
      if (!((mat === 'sand' && (b === 'desert' || b === 'beach')) || (mat === 'stone' && (b === 'mountain' || b === 'peak')))) {
        g.save(); if (common) { g.globalAlpha = 0.6; g.translate(px + 8, py + 8); g.scale(0.75, 0.75); g.translate(-px - 8, -py - 8); } deposit(g, mat, px, py, r); g.restore(); } }
  }
  const isW = (x, y) => { const b = B(x, y); return b === 'sea' || b === 'river'; };

  // ---- deposits: small drawn things lying in the land ----
  function deposit(g, m, px, py, r) {
    const C = (col, x, y, w, h) => { g.fillStyle = col; g.fillRect(px + x, py + y, w, h); };
    const circ = (col, x, y, rad) => { g.fillStyle = col; g.beginPath(); g.arc(px + x, py + y, rad, 0, 7); g.fill(); };
    switch (m) {
      case 'stone': circ('#6e6b66', 6, 10, 3); circ('#9c978f', 5.5, 9.3, 2); circ('#7f7b74', 11, 11, 2.2); break;
      case 'wood': C('#5a3b22', 3, 10, 10, 3); C('#7a5433', 3, 10, 10, 1); circ('#c79a62', 13, 11.5, 1.5); break;
      case 'clay': circ('#9d5a3c', 8, 11, 4); circ('#b86d4b', 7, 10, 2.4); break;
      case 'sand': circ('#d8c48f', 8, 11, 4); circ('#eadbaa', 7, 10, 2); break;
      case 'fiber': for (let i = 0; i < 5; i++) C(i % 2 ? '#b6c86e' : '#8ea24c', 5 + i * 1.5, 5 + (i % 2), 1, 8); break;
      case 'food': circ('#2f5a2c', 8, 9, 4.5); for (let i = 0; i < 4; i++) circ('#d23a5c', 6 + r(100 + i) * 5, 7 + r(110 + i) * 5, 1); break;
      case 'ore': circ('#3e3a44', 8, 10, 4); C('#b48cf0', 6, 8, 1, 1); C('#d0b0ff', 9, 10, 1, 1); C('#9b74d8', 8, 12, 1, 1); break;
      case 'crystal': g.fillStyle = '#7fe6f2'; g.beginPath(); g.moveTo(px + 6, py + 13); g.lineTo(px + 7, py + 4); g.lineTo(px + 9, py + 13); g.fill(); g.fillStyle = '#c8fbff'; g.beginPath(); g.moveTo(px + 9, py + 13); g.lineTo(px + 11, py + 7); g.lineTo(px + 12, py + 13); g.fill(); break;
      case 'marble': C('#d9d5cc', 4, 8, 8, 6); C('#f5f2ec', 4, 8, 8, 2); C('#b8b3aa', 6, 11, 4, 1); break;
      case 'ochre': circ('#a4472a', 8, 10, 4); circ('#c9683a', 7, 9, 2); break;
      case 'indigo': for (let i = 0; i < 3; i++) { C('#3f6a3a', 5 + i * 3, 8, 1, 6); circ('#3b4fb0', 5.5 + i * 3, 7, 1.6); } break;
      case 'shell': circ('#f1dcd2', 8, 10, 3); g.strokeStyle = '#d1a99a'; g.beginPath(); g.moveTo(px + 8, py + 7.5); g.lineTo(px + 8, py + 12.5); g.moveTo(px + 6, py + 8.5); g.lineTo(px + 7, py + 12); g.moveTo(px + 10, py + 8.5); g.lineTo(px + 9, py + 12); g.stroke(); break;
      case 'amber': circ('#8a5a1c', 8, 10, 3.2); circ('#f0a93a', 7.5, 9.5, 2.2); C('#ffe0a0', 6, 8, 1, 1); break;
    }
  }

  function chunk(cx, cy) {
    const k = cx + ',' + cy; let c = chunks.get(k);
    if (c) { chunks.delete(k); chunks.set(k, c); return c; } // keep recently used chunks at the end
    return null;
  }
  // Build a few missing chunks per frame so zooming stays smooth.
  function ensure(list, budget = 3) {
    let made = 0;
    for (const [cx, cy] of list) {
      const k = cx + ',' + cy; if (chunks.has(k)) continue;
      if (made++ >= budget) return false;
      const c = document.createElement('canvas'); c.width = c.height = CH * PX;
      const g = c.getContext('2d');
      for (let j = 0; j < CH; j++) for (let i = 0; i < CH; i++) { const x = cx * CH + i, y = cy * CH + j; if (x < W && y < H) tile(g, x, y, i * PX, j * PX); }
      chunks.set(k, c);
      if (chunks.size > 90) chunks.delete(chunks.keys().next().value);
    }
    return true;
  }

  // ---- blocks ----
  function block(type, color, isWall) {
    const k = type + color; let c = blockCache.get(k); if (c) return c;
    c = document.createElement('canvas'); c.width = c.height = PX; const g = c.getContext('2d'), col = hex(color);
    const F = (k2, x, y, w, h) => { g.fillStyle = rgb(col, k2); g.fillRect(x, y, w, h); };
    F(1, 0, 0, PX, PX);
    switch (type) {
      case 'stone': for (const [x, y, w, h] of [[0, 0, 7, 5], [7, 0, 9, 6], [0, 5, 5, 6], [5, 6, 6, 5], [11, 6, 5, 5], [0, 11, 8, 5], [8, 11, 8, 5]]) { F(0.7, x, y, w, 1); F(0.7, x, y, 1, h); F(1.12, x + 1, y + 1, w - 2, 1); } break;
      case 'cobble': for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { g.fillStyle = rgb(col, 0.8 + ((i * 7 + j * 3) % 5) * 0.08); g.beginPath(); g.arc(2 + i * 4 + (j % 2) * 1.5, 2 + j * 4, 1.8, 0, 7); g.fill(); } break;
      case 'plank': for (let j = 0; j < 4; j++) { F(0.72, 0, j * 4 + 3, PX, 1); F(0.85, (j * 5) % 13 + 2, j * 4, 1, 3); } break;
      case 'floor': for (let i = 0; i < 4; i++) { F(0.78, i * 4 + 3, 0, 1, PX); F(0.9, i * 4 + 1, (i * 7) % 12 + 2, 1, 2); } break;
      case 'log': for (let j = 0; j < 3; j++) { F(0.65, 0, j * 5 + 4, PX, 1); F(1.15, 0, j * 5, PX, 1); g.fillStyle = rgb(col, 1.4); g.beginPath(); g.arc(14, j * 5 + 2.3, 1.6, 0, 7); g.fill(); } break;
      case 'thatch': for (let i = -PX; i < PX; i += 2) { g.strokeStyle = rgb(col, i % 4 ? 0.8 : 1.15); g.beginPath(); g.moveTo(i, PX); g.lineTo(i + PX, 0); g.stroke(); } break;
      case 'brick': for (let j = 0; j < 4; j++) { F(0.62, 0, j * 4 + 3, PX, 1); for (let i = 0; i < 3; i++) F(0.62, ((i * 6 + (j % 2) * 3) % PX), j * 4, 1, 3); F(1.12, 1, j * 4, PX - 2, 1); } break;
      case 'tile': F(0.75, 7, 0, 1, PX); F(0.75, 15, 0, 1, PX); F(0.75, 0, 7, PX, 1); F(0.75, 0, 15, PX, 1); F(1.12, 1, 1, 5, 1); F(1.12, 9, 9, 5, 1); break;
      case 'plaster': F(0.9, 0, 0, PX, 1); F(0.9, 0, 0, 1, PX); for (let i = 0; i < 6; i++) F(0.94 + (i % 2) * 0.08, (i * 5) % 14 + 1, (i * 7) % 14 + 1, 1, 1); break;
      case 'sandstone': for (let j = 0; j < 4; j++) { F(j % 2 ? 0.9 : 1.06, 0, j * 4, PX, 4); F(0.78, 0, j * 4 + 3, PX, 1); } break;
      case 'glass': g.clearRect(0, 0, PX, PX); g.fillStyle = 'rgba(190,228,236,.55)'; g.fillRect(0, 0, PX, PX); g.strokeStyle = 'rgba(255,255,255,.8)'; g.beginPath(); g.moveTo(3, 12); g.lineTo(11, 4); g.moveTo(7, 14); g.lineTo(13, 8); g.stroke(); F(0.7, 0, 0, PX, 1); F(0.7, 0, 15, PX, 1); break;
      case 'cloth': for (let i = 0; i < PX; i += 2) { F(0.85, i, 0, 1, PX); F(1.1, 0, i, PX, 1); } break;
      case 'garden': { g.fillStyle = '#4b7a3a'; g.fillRect(0, 0, PX, PX); const fl = color === '#5f8f4a' ? [240, 220, 120] : col; for (let i = 0; i < 7; i++) { g.fillStyle = rgb(fl, 0.9 + (i % 3) * 0.1); g.beginPath(); g.arc(2 + (i * 5) % 13, 2 + (i * 7) % 13, 1.4, 0, 7); g.fill(); } break; }
      case 'marble': g.strokeStyle = 'rgba(120,118,112,.45)'; g.beginPath(); g.moveTo(0, 4); g.bezierCurveTo(5, 7, 9, 2, 16, 6); g.moveTo(3, 16); g.bezierCurveTo(6, 11, 11, 13, 13, 9); g.stroke(); F(0.9, 0, 15, PX, 1); break;
      case 'mosaic': for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { g.fillStyle = (i + j) % 2 ? rgb(col) : rgb([242, 234, 221]); g.fillRect(i * 4 + 0.5, j * 4 + 0.5, 3, 3); } break;
      case 'iron': F(0.8, 0, 0, PX, 1); F(0.8, 0, 8, PX, 1); for (const [x, y] of [[2, 3], [13, 3], [2, 12], [13, 12]]) { g.fillStyle = rgb(col, 1.7); g.fillRect(x, y, 1, 1); } break;
      case 'crystal': g.fillStyle = rgb(col, 1.2); g.beginPath(); g.moveTo(8, 1); g.lineTo(15, 8); g.lineTo(8, 15); g.lineTo(1, 8); g.fill(); g.fillStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.moveTo(8, 1); g.lineTo(11, 8); g.lineTo(8, 8); g.fill(); break;
      case 'lamp': { F(0.55, 0, 0, PX, PX); const gr = g.createRadialGradient(8, 8, 0, 8, 8, 8); gr.addColorStop(0, '#fff2c4'); gr.addColorStop(0.5, color); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, PX, PX); break; }
    }
    if (isWall) { F(1.18, 0, 0, PX, 2); } // walls catch the light on top
    blockCache.set(k, c); return c;
  }
  return { PX, CH, init, chunk, ensure, block };
})();
