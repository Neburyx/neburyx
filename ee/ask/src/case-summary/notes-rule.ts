import { NOTES_WORD_LIST_VERSION, NOTES_WORDS } from './notes-words.js';

export type NotStorableReason = 'unlisted-word' | 'number-or-date' | 'name' | 'property-value' | 'bound';

export type StorableCheck = { readonly storable: true; readonly wordListVersion: number } | { readonly storable: false; readonly reason: NotStorableReason; readonly wordListVersion: number };

/** Words of a number or a date, which get their own reason; the list holds none of them, so the rule would refuse them anyway. */
const NUMBER_OR_DATE_WORDS: ReadonlySet<string> = new Set(
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion first second third fourth fifth sixth seventh eighth ninth tenth january february march april june july august september october november december monday tuesday wednesday thursday friday saturday sunday'.split(
    ' ',
  ),
);

const PLACEHOLDER = /‹[a-z][a-z0-9-]*#[1-9][0-9]*›/gu;
const TOKEN = /[\p{L}\p{M}\p{N}'’_-]+/gu;

/**
 * Whether a sentence can be stored as AI notes: every token is a word of the fixed list (as written in lower case, or with a capital first letter) or a placeholder the conversion made. A digit makes it
 * `number-or-date`; an unlisted word with a capital letter inside the sentence is taken for a `name`; any other unlisted word, a word with another case, a look-alike character or an unmade placeholder is `unlisted-word`.
 */
export function checkStorable(text: string, placeholders: ReadonlySet<string> = new Set()): StorableCheck {
  const fail = (reason: NotStorableReason): StorableCheck => ({ storable: false, reason, wordListVersion: NOTES_WORD_LIST_VERSION });
  let rest = text;
  for (const found of text.match(PLACEHOLDER) ?? []) {
    if (!placeholders.has(found)) return fail('unlisted-word');
    rest = rest.replace(found, ' ');
  }
  if (/\p{N}/u.test(rest)) return fail('number-or-date');
  if (/[‹›#]/u.test(rest)) return fail('unlisted-word');
  const sentenceStart = /(^|[.!?]\s+)([\p{L}][\p{L}\p{M}'’-]*)/gu;
  const startsOfSentences = new Set<number>();
  for (const match of rest.matchAll(sentenceStart)) startsOfSentences.add((match.index ?? 0) + (match[1]?.length ?? 0));
  for (const match of rest.matchAll(TOKEN)) {
    const word = match[0];
    if (/^[a-z'’-]+$/u.test(word) && NOTES_WORDS.has(word.replace(/[’']/gu, ''))) continue;
    if (NUMBER_OR_DATE_WORDS.has(word.toLowerCase())) return fail('number-or-date');
    const capitalised = /^[A-Z][a-z'’-]*$/u.test(word);
    if (capitalised && startsOfSentences.has(match.index ?? -1) && NOTES_WORDS.has(word.toLowerCase())) continue;
    return fail(capitalised && !startsOfSentences.has(match.index ?? -1) ? 'name' : 'unlisted-word');
  }
  const punctuation = rest.replace(TOKEN, '');
  if (/[^\s.,;:()!?"'’-]/u.test(punctuation)) return fail('unlisted-word');
  return { storable: true, wordListVersion: NOTES_WORD_LIST_VERSION };
}
