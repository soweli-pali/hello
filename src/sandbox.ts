// Scripted objects run in QuickJS (WASM): no I/O, no host access, bounded memory and time.
import { getQuickJS, getQuickJSSync } from 'quickjs-emscripten';

export const LIMITS = { mem: 8 << 20, stack: 256 << 10, ms: 100, gas: 4000, out: 64_000 };
export async function initSandbox() { await getQuickJS(); }

export type RunResult = { ok: true; value: unknown; missing?: boolean } | { ok: false; error: string; missing?: undefined };

// Evaluates `code`, then calls the global function `fn(ctx)` and returns its JSON result.
// fn === '__compile' only evaluates the code (used to reject broken objects at make time).
export function runHandler(code: string, fn: string, ctx: unknown, limits = LIMITS): RunResult {
  const rt = getQuickJSSync().newRuntime();
  rt.setMemoryLimit(limits.mem);
  rt.setMaxStackSize(limits.stack);
  let ticks = 0; const deadline = Date.now() + limits.ms;
  rt.setInterruptHandler(() => ++ticks > limits.gas || Date.now() > deadline);
  const vm = rt.newContext();
  try {
    const ctxStr = vm.newString(JSON.stringify(ctx ?? null));
    vm.setProp(vm.global, '__CTX', ctxStr); ctxStr.dispose();
    const call = fn === '__compile' ? '"null"'
      : `(typeof ${fn} !== 'function') ? '{"__missing":true}' : JSON.stringify({ v: ${fn}(JSON.parse(__CTX)) })`;
    const r = vm.evalCode(`${code}\n;${call}`, 'object.js');
    if (r.error) {
      const err = vm.dump(r.error); r.error.dispose();
      const msg = err?.message ? `${err.name ?? 'Error'}: ${err.message}` : String(err);
      return { ok: false, error: /interrupted/i.test(msg) ? 'ran out of gas (too slow)' : msg.slice(0, 500) };
    }
    const s = vm.typeof(r.value) === 'string' ? vm.getString(r.value) : 'null'; r.value.dispose();
    if (s.length > limits.out) return { ok: false, error: 'result too large' };
    const parsed = JSON.parse(s ?? 'null');
    if (parsed && parsed.__missing) return { ok: true, value: null, missing: true };
    return { ok: true, value: parsed?.v ?? null };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  } finally {
    try { vm.dispose(); rt.dispose(); } catch { /* a runtime that hit its memory limit may not free cleanly */ }
  }
}
