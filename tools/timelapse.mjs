// Timelapse: drives the viewer's replay in a headless browser and writes an animated GIF (plays anywhere, phones included).
//   node tools/timelapse.mjs <viewer url> <out.gif> --at x,y --z 12 [--frames 120] [--size 480x640] [--from 0 --to 1] [--ms 90]
// Needs playwright (for Chromium) and python3 with Pillow.
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(process.env.PLAYWRIGHT_REQUIRE ?? '/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const [url, out] = args;
const [x, y] = opt('at', '512,512').split(',').map(Number), z = Number(opt('z', 12)), N = Number(opt('frames', 120));
const [W, H] = opt('size', '480x640').split('x').map(Number), from = Number(opt('from', 0)), to = Number(opt('to', 1)), follow = opt('follow');
const dir = mkdtempSync(join(tmpdir(), 'tl-'));
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
p.on('pageerror', e => console.error('page:', e.message));
await p.addInitScript(v => localStorage.setItem('hello.view', JSON.stringify(v)), { x: x + 0.5, y: y + 0.5, z });
await p.goto(url + (url.includes('?') ? '&' : '?') + 'replay');
await p.waitForFunction(() => typeof R !== 'undefined' && R.ev && R.ev.length > 0 && R.cps.length > 0, null, { timeout: 120000 });
await p.evaluate(() => { if (R.play) document.querySelector('#tplay').click(); for (const s of ['#zoom', '#minimap', '#tclose', '#tspeed', '#tfollow', '#tplay', 'nav']) document.querySelectorAll(s).forEach(e => e.style.display = 'none'); });
if (follow) await p.evaluate(n => { const a = [...S.agents.values()].find(a => a.name === n); R.follow = a?.id ?? null; }, follow);
await p.waitForTimeout(1500);
for (let k = 0; k < N; k++) {
  await p.evaluate(([f]) => { seek(R.t0 + (R.t1 - R.t0) * f); for (const a of S.agents.values()) { a.dx = a.x; a.dy = a.y; } if (R.follow) { const a = S.agents.get(R.follow); if (a) { view.x = a.x + 0.5; view.y = a.y + 0.5; } } dirty = true; }, [from + (to - from) * k / Math.max(1, N - 1)]);
  await p.waitForTimeout(k === 0 ? 1500 : 110);
  await p.screenshot({ path: join(dir, `f${String(k).padStart(4, '0')}.png`) });
}
await b.close();
writeFileSync(join(dir, 'gif.py'), `
import glob, sys
from PIL import Image
fs = sorted(glob.glob(sys.argv[1] + '/f*.png'))
ims = [Image.open(f).convert('RGB').quantize(colors=200, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in fs]
d = [int(sys.argv[3])] * len(ims); d[-1] = 2500
ims[0].save(sys.argv[2], save_all=True, append_images=ims[1:], duration=d, loop=0, optimize=True, disposal=1)
`);
execFileSync('python3', [join(dir, 'gif.py'), dir, out, opt('ms', '90')], { stdio: 'inherit' });
rmSync(dir, { recursive: true, force: true });
console.log('wrote', out);
