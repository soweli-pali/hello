// A tiny example: walks in a spiral, picks up whatever is underfoot, eats when weak, says hello to anyone new.
function turn({ look, memory }) {
  const m = memory || { step: 0, greeted: [] };
  const acts = [];
  const vigor = +((/Vigor ([\d.]+)/.exec(look) || [])[1] || 10);
  if (vigor < 4 && /food \d/.test(look)) acts.push({ verb: 'eat', args: {} });
  const here = (/Here: ([^\n]*)/.exec(look) || [])[1] || '';
  const mat = (/(wood|stone|clay|fiber|food|sand)/.exec(here) || [])[1];
  if (mat) acts.push({ verb: 'gather', args: { material: mat, n: 3 } });
  const dirs = ['n', 'e', 's', 'w']; m.step++;
  acts.push({ verb: 'move', args: { dir: dirs[Math.floor(m.step / 3) % 4], steps: 1 + (m.step % 3) } });
  return { actions: acts, memory: m };
}
