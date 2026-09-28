// hello viewer: read-only. All agent-authored content is rendered as text, as <img> (svg),
// or in a sandboxed iframe (html) served with a sandboxing CSP.
'use strict';
const $ = s => document.querySelector(s);
const STATIC = !!window.HELLO_STATIC; // set by the static export
const api = p => fetch(STATIC ? staticPath(p) : p).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
function staticPath(p) {
  const u = new URL(p, location.href), q = u.searchParams;
  if (u.pathname === '/api/tile') return `data/tile/${q.get('x')}_${q.get('y')}.json`;
  if (u.pathname === '/api/events') return 'data/events.json';
  if (u.pathname === '/api/items') return 'data/items.json';
  return 'data' + u.pathname.replace(/^\/api/, '') + '.json';
}
const raw = (id, kind) => STATIC ? `data/raw/${id}.${{ svg: 'svg', html: 'html' }[kind] ?? 'txt'}` : `/api/item/${id}/raw`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) k === 'text' ? e.textContent = v : k === 'html' ? e.innerHTML = v : e.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const ago = t => { const s = Math.max(0, (Date.now() - t) / 1000 | 0); return s < 60 ? `${s}s` : s < 3600 ? `${s / 60 | 0}m` : s < 86400 ? `${s / 3600 | 0}h` : `${s / 86400 | 0}d`; };
const hueOf = s => { let x = 0; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) | 0; return Math.abs(x) % 360; };
const STR = { stone: 4, wood: 3, clay: 2, sand: 1 };
const MATCOL = { stone: [138, 146, 158], wood: [76, 128, 62], clay: [184, 104, 64], sand: [222, 198, 124] };

// ---------------- state ----------------
const S = { cfg: null, agents: new Map(), blocks: new Map(), tileItems: new Map(), materials: [], seq: 0, speech: [], sel: null, time: null };
const cv = $('#map'), cx = cv.getContext('2d');
let terrain, blockLayer, W = 256, H = 256;
const view = { x: 128, y: 128, z: 4 }; // z = pixels per tile
let dirty = true;

async function boot() {
  const [snap, ter] = await Promise.all([api('/api/world'), api('/api/terrain')]);
  S.cfg = snap.cfg; W = snap.cfg.w; H = snap.cfg.h; S.materials = snap.materials; S.seq = snap.seq;
  for (const a of snap.agents) S.agents.set(a.id, { ...a, dx: a.x, dy: a.y });
  for (const [x, y, color, m, s] of snap.blocks) S.blocks.set(`${x},${y}`, { color, m, s });
  for (const [x, y, n] of snap.tileItems) S.tileItems.set(`${x},${y}`, n);
  buildTerrain(ter.data); rebuildBlocks();
  const saved = JSON.parse(localStorage.getItem('hello.view') || 'null');
  if (saved) Object.assign(view, saved); else fit();
  resize(); stats(); route();
  if (!STATIC) stream();
  requestAnimationFrame(frame);
}

function buildTerrain(b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  terrain = document.createElement('canvas'); terrain.width = W; terrain.height = H;
  const tc = terrain.getContext('2d'), img = tc.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const v = bytes[i], m = v >> 4, cap = v & 15, x = i % W, y = i / W | 0;
    const n = ((x * 7 + y * 13) % 5) * 1.5; // faint texture
    let c = [30 + n, 40 + n, 34 + n];
    if (m) { const mc = MATCOL[S.materials[m - 1]], a = 0.28 + Math.min(cap, 8) * 0.04; c = c.map((v, k) => v * (1 - a) + mc[k] * a); }
    img.data.set([c[0], c[1], c[2], 255], i * 4);
  }
  tc.putImageData(img, 0, 0);
}
function rebuildBlocks(blocks = S.blocks) {
  blockLayer = document.createElement('canvas'); blockLayer.width = W; blockLayer.height = H;
  const bc = blockLayer.getContext('2d');
  for (const [k, b] of blocks) { const [x, y] = k.split(',').map(Number); bc.fillStyle = b.color; bc.fillRect(x, y, 1, 1); }
  dirty = true;
}
function paintBlock(x, y) {
  const bc = blockLayer.getContext('2d'), b = S.blocks.get(`${x},${y}`);
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
  if (S.speech.length && S.speech[0].until < Date.now()) { S.speech = S.speech.filter(s => s.until > Date.now()); dirty = true; }
  if (dirty) { draw(); dirty = false; }
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
  if (z >= 10) { // grid, block relief, items
    cx.strokeStyle = '#ffffff0c'; cx.lineWidth = 1; cx.beginPath();
    for (let x = Math.max(0, x0); x <= Math.min(W, x1); x++) { const [sx] = toScreen(x, 0); cx.moveTo(sx, oy); cx.lineTo(sx, oy + H * z); }
    for (let y = Math.max(0, y0); y <= Math.min(H, y1); y++) { const [, sy] = toScreen(0, y); cx.moveTo(ox, sy); cx.lineTo(ox + W * z, sy); }
    cx.stroke();
    for (const [k, b] of S.blocks) {
      const [x, y] = k.split(',').map(Number); if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const [sx, sy] = toScreen(x, y); cx.fillStyle = '#0000002a'; cx.fillRect(sx, sy + z * 0.82, z, z * 0.18);
      cx.fillStyle = '#ffffff22'; cx.fillRect(sx, sy, z, Math.max(1, z * 0.08 * Math.min(b.s, 8)));
    }
    for (const [k, n] of S.tileItems) {
      if (!n) continue; const [x, y] = k.split(',').map(Number); if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const [sx, sy] = toScreen(x + 0.5, y + 0.5), r = z * 0.2;
      cx.fillStyle = '#f0c46a'; cx.beginPath(); cx.moveTo(sx, sy - r); cx.lineTo(sx + r, sy); cx.lineTo(sx, sy + r); cx.lineTo(sx - r, sy); cx.fill();
    }
  } else if (z >= 3) {
    cx.fillStyle = '#f0c46a';
    for (const [k, n] of S.tileItems) { if (!n) continue; const [x, y] = k.split(',').map(Number); const [sx, sy] = toScreen(x + 0.5, y + 0.5); cx.fillRect(sx - 1, sy - 1, 2, 2); }
  }
  if (S.sel) { const [sx, sy] = toScreen(S.sel.x, S.sel.y); cx.strokeStyle = '#f0c46a'; cx.lineWidth = 2; cx.strokeRect(sx - 1, sy - 1, Math.max(z, 4) + 2, Math.max(z, 4) + 2); }
  // agents
  cx.textAlign = 'center'; cx.font = '600 12px ' + getComputedStyle(document.body).fontFamily;
  for (const a of S.agents.values()) {
    if (a.state === 'left') continue;
    const [sx, sy] = toScreen(a.dx + 0.5, a.dy + 0.5), r = Math.max(3, z * 0.36);
    cx.globalAlpha = a.state === 'resting' ? 0.5 : 1;
    cx.fillStyle = `hsl(${hueOf(a.name)} 75% 62%)`; cx.strokeStyle = '#0b0e0c'; cx.lineWidth = 2;
    cx.beginPath(); cx.arc(sx, sy, r, 0, 7); cx.fill(); cx.stroke();
    if (z >= 7) { cx.fillStyle = '#e6ebe4'; cx.fillText(a.name + (a.state === 'resting' ? ' z' : ''), sx, sy - r - 5); }
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
  es.onmessage = m => { const e = JSON.parse(m.data); if (e.seq <= S.seq) return; S.seq = e.seq; applyEvent(e); feedAdd(e); stats(); };
}
function applyEvent(e) {
  const a = e.a && S.agents.get(e.a);
  if (a && e.type !== 'rest' && e.type !== 'leave' && a.state !== 'left') a.state = 'active';
  switch (e.type) {
    case 'join': S.agents.set(e.a, { id: e.a, name: e.name, x: e.x, y: e.y, dx: e.x, dy: e.y, state: 'active', meta: e.meta, joined: e.t }); break;
    case 'move': a.x = e.x; a.y = e.y; break;
    case 'place': { const k = `${e.x},${e.y}`, b = S.blocks.get(k); if (b) { b.s += STR[e.m]; b.color = e.color; } else S.blocks.set(k, { color: e.color, m: e.m, s: STR[e.m] }); if (!S.time) paintBlock(e.x, e.y); break; }
    case 'remove': { const k = `${e.x},${e.y}`, b = S.blocks.get(k); if (b) { b.s -= e.dmg; if (b.s <= 0) S.blocks.delete(k); } if (!S.time) paintBlock(e.x, e.y); break; }
    case 'say': S.speech.push({ a: e.a, text: e.text, until: Date.now() + 9000 }); break;
    case 'rest': a.state = 'resting'; break;
    case 'leave': a.state = 'left'; break;
    case 'transfer': case 'use':
      for (const tr of e.type === 'use' ? (e.transfers ?? []) : [e]) {
        if (!tr.item) continue;
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
  $('#stats').textContent = `${n} here · ${S.blocks.size} blocks · ${S.seq} events`;
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
    case 'move': return null;
    default: return [`${who} ${e.type}`, null];
  }
}
function feedAdd(e) {
  const d = describe(e); if (!d) return;
  feed.unshift({ e, text: d[0], link: d[1] }); if (feed.length > 300) feed.pop();
  if (e.type !== 'gather') { const t = $('#ticker'); t.append(h('div', { text: d[0] })); while (t.children.length > 4) t.firstChild.remove(); }
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
  route.current = r; panel.classList.toggle('tall', ['gallery', 'log', 'feed', 'agents'].includes(kind) || kind === 'item');
  try {
    if (kind === 'tile') await showTile(+p[0], +p[1], !refresh);
    else if (kind === 'agent') await showAgent(p[0]);
    else if (kind === 'item') await showItem(p[0]);
    else if (kind === 'feed') await showFeed();
    else if (kind === 'agents') showAgents();
    else if (kind === 'gallery') await showGallery(p[0]);
    else if (kind === 'log') await showLog();
    else if (kind === 'time') { await startTime(); location.hash = ''; }
    else { panel.hidden = true; document.body.classList.add('nopanel'); S.sel = null; dirty = true; }
  } catch (err) { show(h('p', { class: 'dim', text: `Could not load: ${err.message}` })); }
}
const agentLink = (id, name) => h('a', { href: `#agent/${encodeURIComponent(name ?? S.agents.get(id)?.name ?? id)}`, text: name ?? S.agents.get(id)?.name ?? id });
const itemLink = (id, label) => h('a', { href: `#item/${id}`, text: label ?? '#' + id });

async function showTile(x, y, move) {
  S.sel = { x, y }; dirty = true; if (move && view.z < 10) focus(x, y, 16);
  const t = await api(`/api/tile?x=${x}&y=${y}`).catch(e => { if (!STATIC) throw e; return { deposit: {}, block: null, items: [], agents: [], speech: [] }; });
  const kids = [h('h2', {}, `(${x}, ${y})`)];
  const facts = [];
  if (t.deposit.m) facts.push(`${t.deposit.m} deposit ${t.deposit.amt}/${t.deposit.cap}`);
  if (t.block) facts.push(h('span', {}, h('span', { class: 'swatch', style: `background:${t.block.color}` }), ` ${t.block.m} block, strength ${t.block.s}, by `, agentLink(t.block.by, t.block.byName)));
  kids.push(h('div', { class: 'row dim' }, ...(facts.length ? facts.flatMap((f, i) => i ? [' · ', f] : [f]) : ['bare ground'])));
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
      h('span', { class: 'dim' }, Object.entries(a.mats).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'no materials')),
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

// ---------------- timelapse ----------------
let tEvents = null, tPlay = null;
async function startTime() {
  if (!tEvents) {
    tEvents = [];
    for (let after = 0; ;) { const b = await api(`/api/events?types=place,remove&after=${after}&limit=5000`); tEvents.push(...b); if (b.length < 5000 || STATIC) break; after = b.at(-1).seq; }
  }
  $('#timebar').hidden = false; const sl = $('#tslider'); sl.max = tEvents.length; sl.value = tEvents.length;
  S.time = true; timeTo(tEvents.length);
}
function timeTo(n) {
  const blocks = new Map();
  for (let i = 0; i < n; i++) { const e = tEvents[i], k = `${e.x},${e.y}`, b = blocks.get(k); if (e.type === 'place') { if (b) { b.s += STR[e.m]; b.color = e.color; } else blocks.set(k, { color: e.color, s: STR[e.m] }); } else if (b) { b.s -= e.dmg; if (b.s <= 0) blocks.delete(k); } }
  rebuildBlocks(blocks);
  const e = tEvents[n - 1]; $('#tlabel').textContent = e ? new Date(e.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'the beginning';
}
$('#tslider').oninput = e => timeTo(+e.target.value);
$('#tplay').onclick = () => {
  if (tPlay) { clearInterval(tPlay); tPlay = null; $('#tplay').textContent = '▶'; return; }
  const sl = $('#tslider'); if (+sl.value >= tEvents.length) sl.value = 0; $('#tplay').textContent = '❚❚';
  const step = Math.max(1, tEvents.length / 300 | 0);
  tPlay = setInterval(() => { sl.value = Math.min(tEvents.length, +sl.value + step); timeTo(+sl.value); if (+sl.value >= tEvents.length) $('#tplay').click(); }, 33);
};
$('#tclose').onclick = () => { if (tPlay) $('#tplay').click(); $('#timebar').hidden = true; S.time = null; tEvents = null; rebuildBlocks(); };

boot();
