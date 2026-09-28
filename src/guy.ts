// hello-guy: run little guys written by anyone, each in its own locked-down container.
//   hello-guy add <folder>     build it, give it a body in the world, and start it (again: rebuild and restart)
//   hello-guy list | logs <name> [-f] | stop <name> | start <name> | remove <name>
// A guy is a folder with guy.json and code: a Dockerfile, or main.py (+ requirements.txt), or main.js (+ package.json).
// Its container gets HELLO_SERVER, HELLO_TOKEN, HELLO_NAME and only the keys guy.json asks for (from /etc/hello.env).
// It sits on a sealed network: the only way out is the egress proxy, which lets it reach the world and the hosts
// in its "allow" list, nothing else. Memory, CPU and processes are capped; it runs as an unprivileged user,
// with a read-only filesystem except /tmp and /data (its own folder, kept across restarts).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HELLO_HOME ?? '/var/lib/hello', GUYS = join(HOME, 'guys'), NET = 'hello-guys', EGRESS = 'hello-egress';
const env: Record<string, string> = Object.fromEntries(readFileSync(process.env.HELLO_ENV ?? '/etc/hello.env', 'utf8').split('\n')
  .map(l => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*(#.*)?$/.exec(l)).filter(Boolean).map(m => [m![1], m![2].replace(/^["']|["']$/g, '')]));
const WORLD = `${env.HOST ?? '127.0.0.1'}:${env.PORT ?? '7777'}`;
const docker = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const dockerLoud = (...a: string[]) => { const r = spawnSync('docker', a, { stdio: 'inherit' }); if (r.status) throw new Error(`docker ${a[0]} failed`); };
const exists = (kind: 'container' | 'network', n: string) => spawnSync('docker', [kind, 'inspect', n], { stdio: 'ignore' }).status === 0;
const die = (s: string): never => { console.error(s); process.exit(1); };

type Guy = { name: string; at?: [number, number]; look?: Record<string, string>; keys?: string[]; allow?: string[]; memory?: string; cpus?: number; env?: Record<string, string> };
function readGuy(dir: string): Guy {
  const f = join(dir, 'guy.json'); if (!existsSync(f)) die(`${f} is missing`);
  const g = JSON.parse(readFileSync(f, 'utf8')) as Guy;
  if (!/^[A-Za-z][\w.-]{0,31}$/.test(g.name ?? '')) die('guy.json: "name" must be 1-32 letters, digits, _ . - (starting with a letter)');
  for (const k of g.keys ?? []) if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) die(`guy.json: key name "${k}" should look like SOME_API_KEY`);
  for (const h of g.allow ?? []) if (!/^(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(h)) die(`guy.json: allow entry "${h}" should be a host like api.example.com or *.example.com`);
  if (g.memory && !/^\d+[mg]$/.test(g.memory)) die('guy.json: "memory" like "256m" or "1g"');
  return g;
}

// The one door out: a proxy container on both the sealed network and the normal one.
function ensureEgress() {
  if (!exists('network', NET)) docker('network', 'create', '--internal', NET);
  if (exists('container', EGRESS)) { if (docker('inspect', '-f', '{{.State.Running}}', EGRESS) !== 'true') docker('start', EGRESS); return; }
  docker('run', '-d', '--name', EGRESS, '--restart', 'unless-stopped', '--network', 'bridge', '-e', `WORLD=${WORLD}`, '-e', 'GUYS_DIR=/guys',
    '-v', `${join(ROOT, 'deploy', 'egress.mjs')}:/egress.mjs:ro`, '-v', `${GUYS}:/guys:ro`, '--memory', '128m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', '1000:1000', 'node:22-slim', 'node', '/egress.mjs');
  docker('network', 'connect', '--alias', 'egress', NET, EGRESS);
}

function dockerfileFor(src: string): string | null {
  if (existsSync(join(src, 'Dockerfile'))) return null;
  if (existsSync(join(src, 'main.py'))) return `FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN ${existsSync(join(src, 'requirements.txt')) ? 'pip install --no-cache-dir -r requirements.txt' : 'true'}\nCMD ["python", "-u", "main.py"]\n`;
  const js = ['main.js', 'main.mjs', 'main.ts'].find(f => existsSync(join(src, f)));
  if (js) return `FROM node:22-slim\nWORKDIR /app\nCOPY . .\nRUN ${existsSync(join(src, 'package.json')) ? 'npm install --omit=dev' : 'true'}\nCMD ["node", "${js}"]\n`;
  return die('the folder needs a Dockerfile, main.py or main.js');
}

async function join_(g: Guy, dir: string) {
  const tf = join(dir, 'token.json'); if (existsSync(tf)) return JSON.parse(readFileSync(tf, 'utf8'));
  const r = await fetch(`http://${WORLD}/api/join`, { method: 'POST', headers: env.JOIN_KEY ? { 'x-join-key': env.JOIN_KEY } : {}, body: JSON.stringify({ name: g.name, at: g.at, look: g.look, meta: { provider: 'container' } }) });
  const j: any = await r.json(); if (!j.token) die(`joining the world failed: ${j.error ?? j.text ?? r.status}`);
  writeFileSync(tf, JSON.stringify(j)); return j;
}

async function add(folder: string) {
  const srcIn = resolve(folder), g = readGuy(srcIn), dir = join(GUYS, g.name), src = join(dir, 'src'), data = join(dir, 'data');
  const missing = (g.keys ?? []).filter(k => !env[k]); if (missing.length) die(`add ${missing.join(', ')} to /etc/hello.env first`);
  mkdirSync(data, { recursive: true }); rmSync(src, { recursive: true, force: true }); cpSync(srcIn, src, { recursive: true });
  const df = dockerfileFor(src); if (df) writeFileSync(join(src, 'Dockerfile'), df);
  writeFileSync(join(dir, 'guy.json'), JSON.stringify(g, null, 1));
  if (!existsSync(join(dir, 'secret'))) writeFileSync(join(dir, 'secret'), randomBytes(18).toString('hex'));
  execFileSync('chown', ['-R', '1000:1000', data]); execFileSync('chmod', ['755', dir]); execFileSync('chmod', ['644', join(dir, 'secret'), join(dir, 'guy.json')]);
  console.log(`building ${g.name}…`);
  dockerLoud('build', '-q', '-t', `hello-guy-${g.name.toLowerCase()}`, src);
  const tok = await join_(g, dir); ensureEgress();
  const proxy = `http://${g.name}:${readFileSync(join(dir, 'secret'), 'utf8').trim()}@egress:3128`;
  if (exists('container', `guy-${g.name}`)) docker('rm', '-f', `guy-${g.name}`);
  const e = { HELLO_SERVER: `http://${WORLD}`, HELLO_TOKEN: tok.token, HELLO_NAME: g.name, ...(g.env ?? {}), ...Object.fromEntries((g.keys ?? []).map(k => [k, env[k]])),
    HOME: '/tmp', HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1' };
  docker('run', '-d', '--name', `guy-${g.name}`, '--label', 'hello.guy=1', '--restart', 'unless-stopped', '--network', NET,
    '--memory', g.memory ?? '256m', '--cpus', String(Math.min(2, g.cpus ?? 0.5)), '--pids-limit', '256', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:size=64m', '-v', `${data}:/data`, '--user', '1000:1000', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
    ...Object.entries(e).flatMap(([k, v]) => ['-e', `${k}=${v}`]), `hello-guy-${g.name.toLowerCase()}`);
  console.log(`${g.name} is in the world and running. Logs: hello-guy logs ${g.name} -f`);
}

const [cmd, arg, flag] = process.argv.slice(2), c = (n?: string) => `guy-${n ?? die('which guy?')}`;
switch (cmd) {
  case 'add': await add(arg ?? die('usage: hello-guy add <folder>')); break;
  case 'list': console.log(docker('ps', '-a', '--filter', 'label=hello.guy=1', '--format', 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}').replace(/guy-/g, '')); break;
  case 'logs': dockerLoud('logs', '--tail', '200', ...(flag === '-f' ? ['-f'] : []), c(arg)); break;
  case 'stop': docker('stop', c(arg)); console.log('stopped (its body stays in the world, idle)'); break;
  case 'start': docker('start', c(arg)); console.log('started'); break;
  case 'remove': docker('rm', '-f', c(arg)); console.log(`removed the container. Its body stays in the world; to leave for good it can call rest {"leave":true}. Files: ${join(GUYS, arg!)}`); break;
  case 'egress': dockerLoud('logs', '--tail', '100', ...(arg === '-f' ? ['-f'] : []), EGRESS); break;
  default: console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 3).join('\n').replace(/^\/\/ ?/gm, '') + '\n  hello-guy egress [-f]   what the door has refused');
}
