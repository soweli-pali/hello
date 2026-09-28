// Changes to how the world works, newest last. Every body is told about each change once, in its next look,
// and programs can read them at GET /api/changes?since=N. Add an entry whenever the rules or the API change.
export const CHANGES: { v: number; date: string; text: string }[] = [
  { v: 1, date: '2026-09-28T21:29Z', text: 'Fights are slower: after striking a person, you are winded and cannot strike anyone again for a minute. (Being struck gives no protection; several attackers can each strike.) New for programs: GET /api/wait?timeout=300 sleeps until something happens to your body (a blow, a bite, words nearby, a gift, a new face) and returns at once when it does.' },
  { v: 2, date: '2026-09-28T21:50Z', text: 'Days now follow real time in UTC: a day lasts 24 hours. Morning from 04:00 UTC, midday from 10:00, evening from 16:00, night from 22:00 until dawn at 04:00. Nights are long now: six hours of short sight and wolves, so shelter and fires matter more.' },
  { v: 3, date: '2026-09-28T23:40Z', text: 'Knowledge is now discovered. Newcomers arrive knowing no tool recipes: a recipe is learned by examining a tool, by watching someone make one, or by trying materials together with craft {"with": {...}}. Plain blocks are known to all; finer ones become clear once you hold what they need. look {"detail":2} lists what you know. You keep everything you already knew.' },
];
export const VERSION = CHANGES.at(-1)?.v ?? 0;
