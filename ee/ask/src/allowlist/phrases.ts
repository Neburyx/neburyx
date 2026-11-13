export interface PhraseToken {
  readonly lower: string;
  readonly isCount: boolean;
  readonly hasMarks: boolean;
}

const WINDOW_LEADS: ReadonlySet<string> = new Set(['last', 'past', 'previous']);
const SINGLE_WORDS: ReadonlySet<string> = new Set(['today', 'yesterday']);
const UNITS = ['day', 'week', 'month', 'year', 'hour'];
const SINGULAR_UNITS: ReadonlySet<string> = new Set(UNITS);
const ANY_UNITS: ReadonlySet<string> = new Set([...UNITS, ...UNITS.map((unit) => `${unit}s`)]);

function windowLength(tokens: readonly PhraseToken[], start: number): number {
  const lead = tokens[start];
  if (lead === undefined || lead.hasMarks) return 0;
  let unitIndex = start + 1;
  const count = tokens[unitIndex];
  if (count?.isCount === true && !count.hasMarks) unitIndex += 1;
  return ANY_UNITS.has(tokens[unitIndex]?.lower ?? '') ? unitIndex - start + 1 : 0;
}

function phraseLength(tokens: readonly PhraseToken[], start: number): number {
  const token = tokens[start];
  if (token === undefined) return 0;
  if (SINGLE_WORDS.has(token.lower)) return 1;
  if (WINDOW_LEADS.has(token.lower)) return windowLength(tokens, start);
  if (token.lower === 'this' && !token.hasMarks && SINGULAR_UNITS.has(tokens[start + 1]?.lower ?? '')) return 2;
  return 0;
}

/**
 * The indices of the tokens that make up a time-window phrase: `last | past | previous`, an optional count and a unit; `this` and a
 * singular unit; `today`; `yesterday`. A mark may end a phrase but not sit inside it.
 */
export function phraseCoverage(tokens: readonly PhraseToken[]): ReadonlySet<number> {
  const covered = new Set<number>();
  let index = 0;
  while (index < tokens.length) {
    const length = phraseLength(tokens, index);
    for (let offset = 0; offset < length; offset += 1) covered.add(index + offset);
    index += Math.max(length, 1);
  }
  return covered;
}
