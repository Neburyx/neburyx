import type { SummarySentence } from '@neburyx/contracts';
import type { CheckModule } from './check-runner.js';

/** What the checks read of the text that was sent: the text, the line of each element by key, which keys exist, the counts the text gives as not exact and the keys whose count it gives as not known. */
export interface CheckedText {
  readonly text: string;
  readonly keys: ReadonlyMap<string, unknown>;
  readonly lines: ReadonlyMap<string, string>;
  readonly inexactCounts: readonly { readonly phrase: string; readonly value: string }[];
  readonly unknownCountKeys: ReadonlySet<string>;
  /** The keys of lines that state what a read found and are no element: a sentence that cites only these is checked for names against the lines it cites, so it cannot name an element it does not cite. */
  readonly readKeys?: ReadonlySet<string>;
  /** The keys of the lines that say what a type means (`m1`): plain text the operator wrote, no element. A sentence that cites only these and reads is checked for names against the lines it cites; a sentence that cites an element is checked for its numbers against the element lines alone. */
  readonly descriptionKeys?: ReadonlySet<string>;
}

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
  'another', 'other', 'it', 'they', 'there', 'here', 'at', 'in', 'on', 'of', 'by', 'for', 'from', 'with', 'to', 'and', 'or', 'but', 'as', 'is', 'are', 'was', 'were', 'also', 'between', 'within',
  'fan', 'cycle', 'rapid', 'pass', 'through', 'shared', 'shape', 'shapes',
]);

/**
 * Linking and summing words that open a sentence and are written with a capital by grammar alone. A fixed list of the code, never taken from a file. A capitalised first word that is none of these, and whose
 * lower-case, singular or stem form is not an ordinary word of the text sent (a word that is not part of a title or an id), is still taken for a name that was not sent.
 */
const SENTENCE_OPENERS: ReadonlySet<string> = new Set([
  'taken', 'together', 'overall', 'altogether', 'collectively', 'combined', 'additionally', 'furthermore', 'moreover', 'however', 'therefore', 'thus', 'across', 'among', 'alongside', 'beyond', 'according',
  'based', 'given', 'where', 'while', 'when', 'since', 'because', 'although', 'none', 'neither', 'either', 'only', 'per', 'without', 'nothing', 'which', 'whose', 'such', 'most', 'more',
]);

/** Whether a capitalised first word of a sentence is an ordinary word of the text sent: itself, its singular (a plural s or es off), or a stem of five letters or more that a word of the text begins with. Only ordinary words count: the words of a title or an id are names, and a made-up name that is a variant or a prefix of one must not pass. */
function ordinaryOpener(lower: string, ordinary: ReadonlySet<string>): boolean {
  if (SENTENCE_OPENERS.has(lower)) return true;
  const forms = [lower, lower.replace(/s$/u, ''), lower.replace(/es$/u, '')];
  return forms.some((form) => {
    if (ordinary.has(form)) return true;
    if (form.length < 5) return false;
    for (const word of ordinary) if (word.startsWith(form)) return true;
    return false;
  });
}

/** The words of the text sent that are not part of a title or an id of an element: the ordinary words of its lines, its types and its relationship types. */
function ordinaryWords(assembled: CheckedText): Set<string> {
  const names = new Set<string>();
  for (const line of assembled.lines.values()) for (const name of titleAndIdOf(line.normalize('NFC'))) for (const word of words(name)) names.add(word);
  return new Set([...words(assembled.text.normalize('NFC'))].filter((word) => !names.has(word)));
}

/**
 * The words of the verdict check: a sentence that states or implies guilt, fraud, an offence, suspicion, intent or a conclusion (a conclusion that is denied, as in "no conclusion can be drawn", is no verdict). Whole words and their endings, case-insensitive; a word that only holds a stem
 * inside is not matched, and the phrase may be split by any whitespace.
 */
/** @public Exported so a test can hold the packs' descriptions to the same words. */
export const VERDICT = /\b(?:guilt\w*|fraud\w*|launder\w*|crim\w*|offen[cs]e\w*|offender\w*|suspect\w*|suspic\w*|intent\w*|deliberate\w*|illegal\w*|unlawful\w*|convict\w*|culprit\w*|perpetrator\w*|proves?|proof|responsible\s+for)\b/i;

/** The word of a conclusion, which a sentence may use to say that none can be drawn: it is a verdict unless a negation stands within the three words before it. */
const CONCLUSION = /\b(?:conclud\w*|conclusion\w*)\b/giu;
const NEGATIONS = new Set(['no', 'not', 'cannot', 'nothing', 'without', 'never']);
const WORD = /[\p{L}\p{N}'’]+/gu;

/** Whether a negation stands within the three words before the position; `not` followed by `only` is no negation, and neither is anything outside those three words. */
function negatedBefore(text: string, position: number): boolean {
  const words = (text.slice(0, position).toLowerCase().match(WORD) ?? []).slice(-3);
  return words.some((word, index) => (NEGATIONS.has(word) || /n['’]t$/u.test(word)) && !(word === 'not' && words[index + 1] === 'only'));
}

/** Whether the text uses a word of a conclusion without a negation before it: only the words of the conclusion are excused by a negation, every other word of the verdict list stays one. */
function statesConclusion(text: string): boolean {
  return [...text.matchAll(CONCLUSION)].some((found) => !negatedBefore(text, found.index));
}

/**
 * Whether the operator's description of a type holds a word of the verdict list (or a conclusion that is not denied), the name of the type itself excepted: such a description is not shown, and the type gets the fixed sentence of a type with no description.
 */
export function descriptionHoldsVerdict(description: string, ownNames: readonly string[]): boolean {
  const left = [...ownNames].sort((a, b) => b.length - a.length).reduce((text, name) => text.replace(new RegExp(`(?<![\\p{L}\\p{N}_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'giu'), ' '), description);
  const hit = VERDICT.test(left);
  return hit || statesConclusion(left);
}

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

/** The words of a text, lower case; a word joined with underscores (`transferred_to`) is held whole and in its parts, so that the capitals of `TRANSFERRED_TO` are found in the text sent. */
const words = (text: string): Set<string> => new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).flatMap((word) => (word.includes('_') ? [word, ...word.split('_').filter((part) => part !== '')] : [word])));

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

const TYPE_LINE = /^m\d+: (?:entity|relationship) type (.+?): "/u;

/** The name of the type an `m` line is about: the type's own name is a name and not a verdict word, as an element's title is; the words of its description are not exempt. */
const typeNameOf = (line: string): string[] => {
  const found = TYPE_LINE.exec(line);
  return found?.[1] === undefined ? [] : [found[1]];
};

/**
 * Whether a sentence states a verdict. The title and the id of an element the sentence cites are what the text sent says that element is called, so a word of the verdict list inside them (a business called
 * "Crimson Trading") is a name and not a verdict; the same word anywhere else in the sentence still is one. A title is taken out only as a whole (not as part of a longer word), longest first. The limit: an
 * element whose title or id is itself only a word of the list, cited by the sentence, hides that word wherever the sentence says it; the title comes from the source, and the sentence has to cite the element.
 */
function holdsVerdict(sentence: SummarySentence, assembled: CheckedText): boolean {
  const names = sentence.cites.flatMap((cite) => [...titleAndIdOf(assembled.lines.get(cite) ?? ''), ...typeNameOf(assembled.lines.get(cite) ?? '')]).sort((left, right) => right.length - left.length);
  const left = names.reduce((text, name) => text.replace(new RegExp(`(?<![\\p{L}\\p{N}_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'giu'), ' '), sentence.text);
  return VERDICT.test(left) || statesConclusion(left);
}

function citationsHold(sentence: SummarySentence, assembled: CheckedText): boolean {
  return sentence.cites.length > 0 && sentence.cites.every((cite) => assembled.keys.has(cite));
}

function numbersHold(sentence: SummarySentence, assembled: CheckedText): boolean {
  const numbers = numbersIn(sentence.text);
  if (numbers.length === 0) return true;
  if (sentence.cites.some((cite) => assembled.unknownCountKeys.has(cite))) return false;
  const descriptions = assembled.descriptionKeys;
  const elementCites = descriptions === undefined ? sentence.cites : sentence.cites.filter((cite) => !descriptions.has(cite));
  // a sentence that cites an element holds the numbers of the element lines alone; one that cites only meanings may restate their numbers
  const numberCites = elementCites.length === 0 ? sentence.cites : elementCites;
  const cited = new Set(numberCites.flatMap((cite) => numbersIn(assembled.lines.get(cite) ?? '')));
  if (!numbers.every((number) => cited.has(number))) return false;
  const standalone = numbersIn(sentence.text, true);
  return assembled.inexactCounts.every((count) => !standalone.includes(count.value) || sentence.text.includes(count.phrase));
}

/** The text a sentence's names are checked against: all of it, or, for a sentence that cites only the lines of reads, the lines it cites. */
function namesScopeOf(sentence: SummarySentence, assembled: CheckedText): CheckedText {
  const reads = assembled.readKeys;
  const descriptions = assembled.descriptionKeys;
  const meanings = descriptions === undefined ? [] : sentence.cites.filter((cite) => descriptions.has(cite));
  const onlyLines = sentence.cites.length > 0 && sentence.cites.every((cite) => reads?.has(cite) === true || descriptions?.has(cite) === true);
  if (!onlyLines) {
    // a sentence that cites an element and a meaning is checked against the text sent and the meanings it cites
    if (meanings.length === 0) return assembled;
    return { ...assembled, text: [assembled.text, ...meanings.map((cite) => assembled.lines.get(cite) ?? '')].join('\n') };
  }
  const lines = new Map(sentence.cites.flatMap((cite) => (assembled.lines.has(cite) ? [[cite, assembled.lines.get(cite) ?? ''] as const] : [])));
  return { ...assembled, text: [...lines.values()].join('\n'), lines };
}

function namesHold(sentence: SummarySentence, assembled: CheckedText): boolean {
  const sent = assembled.text.normalize('NFC');
  const known = words(sent);
  const ordinary = ordinaryWords(assembled);
  const sentTokens = identifierTokens(sent);
  const text = sentence.text.normalize('NFC');
  for (const quoted of text.matchAll(QUOTED)) if (!occursWhole(quoted[1] ?? '', sent)) return false;
  // a decimal point between digits is not the end of a sentence: it is taken out so that what follows is not read as the start of one
  const unquoted = text.replace(QUOTED, ' ').replace(/(\d)\.(\d)/gu, '$1 $2');
  for (const token of unquoted.match(IDENTIFIER_LIKE) ?? []) {
    // a word joined with underscores between letters or digits is one name (a relationship type): it is found whole in the text sent, never as a mix of the parts of others; Markdown emphasis around a word is not one
    if (!sentTokens.has(token) && token.split('-').some((part) => /[\p{L}\p{N}]_[\p{L}\p{N}]/u.test(part) && !known.has(part.replace(/^_+|_+$/gu, '').toLowerCase()))) return false;
    if (SHAPE_WORDS.has(token.toLowerCase()) || !/\d/.test(token) || !/[\p{L}_-]/u.test(token)) continue;
    if (!sentTokens.has(token)) return false;
  }
  const withoutIdentifiers = unquoted.replace(IDENTIFIER_LIKE, (token) => (/\d/.test(token) ? ' '.repeat(token.length) : token));
  for (const found of withoutIdentifiers.matchAll(CAPITALISED)) {
    const lower = found[0].toLowerCase();
    if (STRUCTURAL_VOCABULARY.has(lower) || known.has(lower)) continue;
    const opensSentence = /(^\s*|[.!?]\s+)$/u.test(withoutIdentifiers.slice(0, found.index));
    if (opensSentence && ordinaryOpener(lower, ordinary)) continue;
    return false;
  }
  return true;
}

const KEY = '[nersm]\\d+';
const KEY_GROUP = new RegExp(`\\s*[(\\[]\\s*${KEY}(?:\\s*(?:,|;|and|&)\\s*${KEY})*\\s*[)\\]]`, 'gu');
const KEY_WORD = new RegExp(`(?<![\\p{L}\\p{N}_-])${KEY}(?![\\p{L}\\p{N}_-])`, 'u');

/**
 * The text of a sentence without the keys of the elements sent. A key in parentheses or brackets, alone or in a list (`(n1)`, `(n1, e2)`), is taken out with the space before it: the sentence reads the same without it.
 * A key anywhere else stands in the grammar for a name (`n1 sent money to n3`), so taking it out would leave a gap and the sentence is removed. A key that was not sent is not this check's: the name check removes it.
 */
function withoutKeys(text: string, assembled: CheckedText): { readonly text: string; readonly stripped: boolean } | undefined {
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
export function judgeSentences(sentences: readonly SummarySentence[], assembled: CheckedText): Judged {
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
    if (!citationsHold(sentence, assembled) || !numbersHold(sentence, assembled) || !namesHold(sentence, namesScopeOf(sentence, assembled))) removed += 1;
    else {
      kept.push(sentence);
      if (clean.stripped) keysStripped += 1;
    }
  }
  return { kept, removed, verdictFound, keysStripped, keysRemoved };
}

export interface JudgeInput {
  readonly sentences: readonly SummarySentence[];
  readonly text: CheckedText;
}

/** The check as a worker thread runs it: one argument, since a worker is handed one value. */
export function judgeInput(input: JudgeInput): Judged {
  return judgeSentences(input.sentences, input.text);
}

export const JUDGE_MODULE: CheckModule = { url: new URL('./reply-checks.js', import.meta.url).href, exportName: 'judgeInput' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isSentence = (value: unknown): value is SummarySentence => isRecord(value) && typeof value['text'] === 'string' && Array.isArray(value['cites']) && value['cites'].every((cite) => typeof cite === 'string');

/** Reads the result a worker sent back; undefined for anything that is not the result of the check. */
export function parseJudged(value: unknown): Judged | undefined {
  if (!isRecord(value) || !Array.isArray(value['kept']) || !value['kept'].every(isSentence)) return undefined;
  const { removed, keysStripped, keysRemoved, verdictFound } = value;
  if (typeof removed !== 'number' || typeof keysStripped !== 'number' || typeof keysRemoved !== 'number' || typeof verdictFound !== 'boolean') return undefined;
  return { kept: value['kept'], removed, keysStripped, keysRemoved, verdictFound };
}
