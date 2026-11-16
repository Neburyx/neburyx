import type { SummarySentence } from '@neburyx/contracts';
import type { AssembledText } from './assemble.js';

const NUMBER_TOKEN = /[-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)/g;
const TOKEN = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;
const IDENTIFIER_LIKE = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;
const QUOTED = /"([^"]+)"/g;
const CAPITALISED = /\p{Lu}[\p{L}]*/gu;

/** Shape words that look like identifiers and are allowed: they come from the typology file the model is told to use. */
const SHAPE_WORDS: ReadonlySet<string> = new Set(['fan-in', 'fan-out', 'pass-through']);

/** The ordinary words a sentence may start with or hold in a capital without naming anything: articles, determiners, small number words, prepositions, conjunctions and the five shapes. A fixed list of the code, never taken from a file. */
const STRUCTURAL_VOCABULARY: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'both', 'each', 'every', 'all', 'no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'several', 'some', 'many', 'few',
  'another', 'other', 'it', 'they', 'there', 'here', 'at', 'in', 'on', 'of', 'by', 'for', 'from', 'with', 'to', 'and', 'or', 'but', 'as', 'is', 'are', 'was', 'were', 'also', 'both', 'between', 'within',
  'fan', 'cycle', 'rapid', 'pass', 'through', 'shared', 'shape', 'shapes',
]);

/**
 * The words of the verdict check: a sentence that states or implies guilt, fraud, an offence, suspicion, intent or a conclusion. Whole words and their endings, case-insensitive; a word that only holds a stem
 * inside is not matched, and the phrase may be split by any whitespace.
 */
const VERDICT = /\b(?:guilt\w*|fraud\w*|launder\w*|crim\w*|offen[cs]e\w*|offender\w*|suspect\w*|suspic\w*|intent\w*|deliberate\w*|illegal\w*|unlawful\w*|convict\w*|culprit\w*|perpetrator\w*|conclud\w*|conclusion\w*|proves?|proof|responsible\s+for)\b/i;

export interface Judged {
  readonly kept: readonly SummarySentence[];
  readonly removed: number;
  /** How many kept sentences had a key written in parentheses or brackets taken out of their text. */
  readonly keysStripped: number;
  /** How many sentences were removed because a key stood in their text outside parentheses. */
  readonly keysRemoved: number;
  /** True when a sentence was removed for its wording: the reply is asked for again while calls remain. */
  readonly verdictFound: boolean;
}

const normalise = (token: string): string => token.replaceAll(',', '').replace(/^\+/, '');

/**
 * The standalone numbers of a text, with a sign or a leading point when they have one. A word or identifier (a token with a letter or an underscore, whatever digits it holds, such as `W-1` or `123ABC`) is not a
 * number; a token of digits, hyphens, points and commas (a date) is. A sentence's quoted texts can be left out of its count-label check, since the name check judges them.
 */
const numbersIn = (text: string, leaveQuotedOut = false): string[] => {
  const plain = (leaveQuotedOut ? text.replace(QUOTED, ' ') : text).replace(TOKEN, (token) => (/[\p{L}_]/u.test(token) ? ' ' : token));
  return (plain.match(NUMBER_TOKEN) ?? []).map(normalise);
};

/** Whether a text occurs in another as a whole: not in the middle of a longer word or identifier. */
const occursWhole = (text: string, inside: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}_-])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'u').test(inside);

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);

const identifierTokens = (text: string): Set<string> => new Set(text.match(IDENTIFIER_LIKE) ?? []);

const TITLE_AND_ID = /\| title: ("(?:[^"\\]|\\.)*") \| id: ("(?:[^"\\]|\\.)*")/u;

/** The title and the id of an element, as its line of the text sent holds them: strings written as JSON. */
function titleAndIdOf(line: string): string[] {
  const found = TITLE_AND_ID.exec(line);
  if (found === null) return [];
  return [found[1], found[2]].flatMap((quoted) => {
    try {
      const value: unknown = JSON.parse(quoted ?? '');
      return typeof value === 'string' && value !== '' ? [value] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Whether a sentence states a verdict. The title and the id of an element the sentence cites are what the text sent says that element is called, so a word of the verdict list inside them (a business called
 * "Crimson Trading") is a name and not a verdict; the same word anywhere else in the sentence still is one. A title is taken out only as a whole (not as part of a longer word), longest first. The limit: an
 * element whose title or id is itself only a word of the list, cited by the sentence, hides that word wherever the sentence says it; the title comes from the source, and the sentence has to cite the element.
 */
function holdsVerdict(sentence: SummarySentence, assembled: AssembledText): boolean {
  const names = sentence.cites.flatMap((cite) => titleAndIdOf(assembled.lines.get(cite) ?? '')).sort((left, right) => right.length - left.length);
  const left = names.reduce((text, name) => text.replace(new RegExp(`(?<![\\p{L}\\p{N}_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'giu'), ' '), sentence.text);
  return VERDICT.test(left);
}

function citationsHold(sentence: SummarySentence, assembled: AssembledText): boolean {
  return sentence.cites.length > 0 && sentence.cites.every((cite) => assembled.keys.has(cite));
}

function numbersHold(sentence: SummarySentence, assembled: AssembledText): boolean {
  const numbers = numbersIn(sentence.text);
  if (numbers.length === 0) return true;
  if (sentence.cites.some((cite) => assembled.unknownCountKeys.has(cite))) return false;
  const cited = new Set(sentence.cites.flatMap((cite) => numbersIn(assembled.lines.get(cite) ?? '')));
  if (!numbers.every((number) => cited.has(number))) return false;
  const standalone = numbersIn(sentence.text, true);
  return assembled.inexactCounts.every((count) => !standalone.includes(count.value) || sentence.text.includes(count.phrase));
}

function namesHold(sentence: SummarySentence, assembled: AssembledText): boolean {
  const sent = assembled.text;
  const known = words(sent);
  const sentTokens = identifierTokens(sent);
  for (const quoted of sentence.text.matchAll(QUOTED)) if (!occursWhole(quoted[1] ?? '', sent)) return false;
  const unquoted = sentence.text.replace(QUOTED, ' ');
  for (const token of unquoted.match(IDENTIFIER_LIKE) ?? []) {
    if (SHAPE_WORDS.has(token.toLowerCase()) || !/\d/.test(token) || !/[\p{L}_-]/u.test(token)) continue;
    if (!sentTokens.has(token)) return false;
  }
  const withoutIdentifiers = unquoted.replace(IDENTIFIER_LIKE, (token) => (/\d/.test(token) ? ' ' : token));
  for (const word of withoutIdentifiers.match(CAPITALISED) ?? []) {
    const lower = word.toLowerCase();
    if (!STRUCTURAL_VOCABULARY.has(lower) && !known.has(lower)) return false;
  }
  return true;
}

const KEY = '[ne]\\d+';
const KEY_GROUP = new RegExp(`\\s*[(\\[]\\s*${KEY}(?:\\s*(?:,|;|and|&)\\s*${KEY})*\\s*[)\\]]`, 'gu');
const KEY_WORD = new RegExp(`(?<![\\p{L}\\p{N}_-])${KEY}(?![\\p{L}\\p{N}_-])`, 'u');

/**
 * The text of a sentence without the keys of the elements sent. A key in parentheses or brackets, alone or in a list (`(n1)`, `(n1, e2)`), is taken out with the space before it: the sentence reads the same without it.
 * A key anywhere else stands in the grammar for a name (`n1 sent money to n3`), so taking it out would leave a gap and the sentence is removed. A key that was not sent is not this check's: the name check removes it.
 */
function withoutKeys(text: string, assembled: AssembledText): { readonly text: string; readonly stripped: boolean } | undefined {
  const sentKey = (token: string): boolean => assembled.keys.has(token);
  let stripped = false;
  const cleaned = text.replace(KEY_GROUP, (group) => {
    const inside = group.match(new RegExp(KEY, 'gu')) ?? [];
    if (!inside.every(sentKey)) return group;
    stripped = true;
    return '';
  });
  // a group that holds a key that was not sent stays in the text, for the name check; the keys outside every group are the ones that stand for a name
  for (const word of text.replace(KEY_GROUP, ' ').match(new RegExp(KEY_WORD.source, 'gu')) ?? []) if (sentKey(word)) return undefined;
  const tidy = cleaned.trim();
  return tidy === '' || !/\p{L}/u.test(tidy) ? undefined : { text: stripped ? tidy : text, stripped };
}

/** Keeps the sentences that cite real elements, hold only the numbers of the elements they cite and the ids, quoted texts and capitalised words the text sent holds, and state no verdict, with the keys of the elements taken out of their text; counts each removed sentence once. */
export function judgeSentences(sentences: readonly SummarySentence[], assembled: AssembledText): Judged {
  const kept: SummarySentence[] = [];
  let removed = 0;
  let verdictFound = false;
  let keysStripped = 0;
  let keysRemoved = 0;
  for (const original of sentences) {
    if (holdsVerdict(original, assembled)) {
      verdictFound = true;
      removed += 1;
      continue;
    }
    const clean = withoutKeys(original.text, assembled);
    if (clean === undefined) {
      removed += 1;
      keysRemoved += 1;
      continue;
    }
    const sentence = clean.stripped ? { ...original, text: clean.text } : original;
    if (!citationsHold(sentence, assembled) || !numbersHold(sentence, assembled) || !namesHold(sentence, assembled)) removed += 1;
    else {
      kept.push(sentence);
      if (clean.stripped) keysStripped += 1;
    }
  }
  return { kept, removed, verdictFound, keysStripped, keysRemoved };
}
