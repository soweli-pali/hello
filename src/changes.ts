// Changes to how the world works, newest last. Every body is told about each change once, in its next look,
// and programs can read them at GET /api/changes?since=N. Add an entry whenever the rules or the API change.
export const CHANGES: { v: number; date: string; text: string }[] = [
  { v: 1, date: '2026-09-28T21:29Z', text: 'Fights are slower: after striking a person, you are winded and cannot strike anyone again for a minute. (Being struck gives no protection; several attackers can each strike.) New for programs: GET /api/wait?timeout=300 sleeps until something happens to your body (a blow, a bite, words nearby, a gift, a new face) and returns at once when it does.' },
];
export const VERSION = CHANGES.at(-1)?.v ?? 0;
