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

/** Keeps the sentences that cite real elements, hold only the numbers of the elements they cite and the ids, quoted texts and capitalised words the text sent holds, and state no verdict; counts each removed sentence once. */
export function judgeSentences(sentences: readonly SummarySentence[], assembled: AssembledText): Judged {
  const kept: SummarySentence[] = [];
  let removed = 0;
  let verdictFound = false;
  for (const sentence of sentences) {
    if (VERDICT.test(sentence.text)) {
      verdictFound = true;
      removed += 1;
    } else if (!citationsHold(sentence, assembled) || !numbersHold(sentence, assembled) || !namesHold(sentence, assembled)) removed += 1;
    else kept.push(sentence);
  }
  return { kept, removed, verdictFound };
}
