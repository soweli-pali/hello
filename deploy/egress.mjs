// The only way out of a guy's container. Each guy authenticates with its name and secret (in its proxy URL),
// and may reach only the world server plus the hosts listed in its guy.json "allow". Everything else is refused.
// Runs in its own container, on both the guys' sealed network and the normal one. Plain Node, no dependencies.
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';

const DIR = process.env.GUYS_DIR ?? '/guys', WORLD = process.env.WORLD ?? '', PORT = 3128;
// On the world server a guy may use only the body's own API, not the viewer's (which shows the whole map).
const WORLD_PATHS = /^\/api\/(act|wait|intro|verbs|changes|picture)(\?|$)/;
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

function who(req) {
  const [u, p] = Buffer.from(String(req.headers['proxy-authorization'] ?? '').replace(/^Basic\s+/i, ''), 'base64').toString().split(':');
  if (!u || !/^[\w.-]{1,32}$/.test(u)) return null;
  try {
    if (readFileSync(`${DIR}/${u}/secret`, 'utf8').trim() !== p) return null;
    const g = JSON.parse(readFileSync(`${DIR}/${u}/guy.json`, 'utf8'));
    return { name: u, allow: [...(Array.isArray(g.allow) ? g.allow : []), WORLD].filter(Boolean).map(String) };
  } catch { return null; }
}
// "api.example.com" (ports 80/443), "*.example.com", or "host:port"
function allowed(g, host, port) {
  host = host.toLowerCase().replace(/^\[|\]$/g, '');
  return g.allow.some(a => {
    const i = a.lastIndexOf(':'), ah = (i > 0 && !a.includes(']') ? a.slice(0, i) : a).toLowerCase(), ap = i > 0 ? a.slice(i + 1) : '';
    const hostOk = ah.startsWith('*.') ? host.endsWith(ah.slice(1)) : host === ah;
    return hostOk && (ap ? String(port) === ap : port === 443 || port === 80);
  });
}
const deny = (res, g, what) => { log('refused', g?.name ?? '(unknown)', what); res.writeHead(g ? 403 : 407, { 'proxy-authenticate': 'Basic realm="hello"', 'content-type': 'text/plain' }); res.end(g ? `hello egress: ${what} is not in this guy's "allow" list\n` : 'hello egress: bad proxy credentials\n'); };

const server = http.createServer((req, res) => { // plain http: forward absolute-URI requests
  const g = who(req); let u; try { u = new URL(req.url); } catch { return deny(res, g, 'a bad URL'); }
  const port = Number(u.port || 80);
  if (!g || !allowed(g, u.hostname, port)) return deny(res, g, `${u.hostname}:${port}`);
  if (`${u.hostname}:${port}` === WORLD && !WORLD_PATHS.test(u.pathname + u.search)) return deny(res, g, `${u.pathname} on the world (bodies may use /api/act, wait, intro, verbs, changes and picture)`);
  const headers = { ...req.headers }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
  const up = http.request({ host: u.hostname, port, path: u.pathname + u.search, method: req.method, headers }, r => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on('error', e => { res.writeHead(502); res.end(`hello egress: ${e.message}\n`); });
  req.pipe(up);
});
server.on('connect', (req, sock, head) => { // https and anything else: a tunnel to an allowed host
  const g = who(req), [host, p] = String(req.url).split(/:(?=\d+$)/), port = Number(p || 443);
  if (!g || !allowed(g, host, port) || `${host}:${port}` === WORLD) { log('refused', g?.name ?? '(unknown)', `${host}:${port}`); sock.end(`HTTP/1.1 ${g ? 403 : 407} Refused\r\n\r\n`); return; }
  const up = net.connect(port, host, () => { sock.write('HTTP/1.1 200 Connection established\r\n\r\n'); if (head.length) up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on('error', () => sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')); sock.on('error', () => up.destroy());
});
server.listen(PORT, () => log(`egress on :${PORT}; world ${WORLD}`));
