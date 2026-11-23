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
  /** The type of each element key (an entity type, or a relationship type), so that the comparison check knows which elements are of one type without the references a worker thread would have to copy. */
  readonly elementTypes?: ReadonlyMap<string, string>;
  /** The words of the instructions the model was given, lower case (a typology the operator wrote, for one): a capital word that is one of them names nothing that was not sent. */
  readonly knownWords?: readonly string[];
  /** The titles and ids of each element, by key: what a count names apart from itself is found by, whatever shape the element's line is written in. */
  readonly elementNames?: ReadonlyMap<string, readonly string[]>;
  /** False for the rows of a table: a cardinal written in words is read as a number everywhere else. */
  readonly readWordNumbers?: boolean;
  /** The keys of the properties each element's line holds a value for, by the element's key. */
  readonly propertyKeys?: ReadonlyMap<string, readonly string[]>;
  /** The keys of the elements each read listed, by the key of the read's own line: only a line of a read that listed an element speaks for it. */
  readonly readElements?: ReadonlyMap<string, readonly string[]>;
}

const NUMBER_TOKEN = /[-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)/g;
const TOKEN = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;
const IDENTIFIER_LIKE = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;
const QUOTED = /"([^"]+)"/g;
const CAPITALISED = /\p{Lu}[\p{L}]*/gu;

/** The ordinary words a sentence may start with or hold in a capital without naming anything: articles, determiners, small number words, prepositions and conjunctions: language, never a word of a domain. The words of a domain (a shape of a typology, a type) come from the text sent and the instructions the model was given. */
const STRUCTURAL_VOCABULARY: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'both', 'each', 'every', 'all', 'no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'several', 'some', 'many', 'few',
  'another', 'other', 'it', 'they', 'there', 'here', 'at', 'in', 'on', 'of', 'by', 'for', 'from', 'with', 'to', 'and', 'or', 'but', 'as', 'is', 'are', 'was', 'were', 'also', 'between', 'within',
  'through',
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

export const REMOVAL_REASONS = ['verdict', 'key', 'citation', 'number', 'count', 'comparison', 'name', 'label', 'cell', 'row'] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

export interface RejectedSentence {
  readonly text: string;
  readonly reason: RemovalReason;
}

const isRemovalReason = (value: unknown): value is RemovalReason => REMOVAL_REASONS.some((reason) => reason === value);

export interface Judged {
  readonly kept: readonly SummarySentence[];
  readonly removed: number;
  /** Each removed sentence with the reason of the check that removed it: as many as `removed`. */
  readonly rejected: readonly RejectedSentence[];
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

/** The standalone numbers of a text with the text that follows each; a word or identifier is blanked to the same length, so the positions are those of the sentence. */
const numberMentionsIn = (text: string): { readonly value: string; readonly after: string }[] => {
  const plain = text.replace(TOKEN, (token) => (/[\p{L}_]/u.test(token) ? ' '.repeat(token.length) : token));
  return [...plain.matchAll(NUMBER_TOKEN)].map((found) => ({ value: normalise(found[0]), after: text.slice(found.index + found[0].length) }));
};

const NUMBER_UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const NUMBER_TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const NUMBER_WORD = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:(?:${NUMBER_TENS.join('|')})(?:-(?:${NUMBER_UNITS.slice(1, 10).join('|')}))?|${NUMBER_UNITS.join('|')})(?![\\p{L}\\p{N}_-])`, 'giu');

/** The value of a cardinal written in words, from zero to ninety-nine (`twenty-five` is 25). */
function numberWordValue(word: string): string {
  const [head = '', unit] = word.toLowerCase().split('-');
  const tens = NUMBER_TENS.indexOf(head);
  return String(tens >= 0 ? (tens + 2) * 10 + (unit === undefined ? 0 : NUMBER_UNITS.indexOf(unit)) : NUMBER_UNITS.indexOf(head));
}

/** The values of the cardinals written in words from eleven up in a line of the text sent, quoted values included: a reply that restates `twenty-five` finds it where the line holds it. */
const writtenValuesOfLine = (line: string): string[] => [...line.matchAll(NUMBER_WORD)].map((found) => numberWordValue(found[0])).filter((value) => Number(value) > 10);

/**
 * The cardinals written in words, outside quoted text (a quoted title is a name the name check judges), as the digits would give them. One is `counting` when a word that names a type of an element the text sent holds,
 * or a kind (entity, relationship, element), follows at once: the count rule may then verify it against the cited elements. From eleven up every cardinal is a number to verify; the words up to ten are ordinary words of
 * a sentence (`one of`, `no one`, `two payments`) that no number check reads unless they count.
 */
function writtenNumbersIn(text: string, assembled: CheckedText): { readonly index: number; readonly length: number; readonly value: string; readonly after: string; readonly counting: boolean }[] {
  if (assembled.readWordNumbers === false) return [];
  const types = assembled.elementTypes === undefined ? [] : [...new Set([...assembled.elementTypes.values()].map(elementTypeName)), 'entity', 'relationship', 'element'];
  const outside = text.replace(QUOTED, (quoted) => ' '.repeat(quoted.length));
  return [...outside.matchAll(NUMBER_WORD)].flatMap((found) => {
    const value = numberWordValue(found[0]);
    const after = text.slice(found.index + found[0].length);
    const counting = /^\s+\S/u.test(after) && types.some((name) => namesType(after.trimStart(), name));
    return Number(value) <= 10 && !counting ? [] : [{ index: found.index, length: found[0].length, value, after, counting }];
  });
}

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

/** The words a type's name is written with, lower case: `RECEIVED_BY` gives `received by`. */
const elementTypeName = (elementType: string): string => elementType.replace(/^(?:entity|relationship) /u, '').toLowerCase().replaceAll('_', ' ').replace(/\s+/gu, ' ').trim();

/** The length of the name of the type, as the singular or the plural, that the text after a number opens with, whole, across any white space or underscore between its words; nothing when it opens with none. */
function typeWordLength(after: string, name: string): number | undefined {
  if (name === '') return undefined;
  const parts = name.split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const last = parts.pop() ?? '';
  const forms = [last, `${last}s`, `${last}es`, ...(last.endsWith('y') ? [`${last.slice(0, -1)}ies`] : [])];
  const opening = new RegExp(`^\\s*${[...parts, `(?:${forms.join('|')})`].join('[\\s_]+')}(?![\\p{L}\\p{N}_-])`, 'iu').exec(after);
  return opening?.[0].length;
}

const namesType = (after: string, name: string): boolean => typeWordLength(after, name) !== undefined;

/**
 * Words that say a number is about a population other than the elements the sentence cites: the whole source, what was not retrieved, shown or counted here, or a bound or an approximation. A fixed list of the code. A sentence with one of them
 * is never verified by counting its cited elements, because a cited subset says nothing of a total, of what was not retrieved, or of a bound.
 */
const OTHER_POPULATION = /(?<![\p{L}\p{N}_-])(?:in total|total|totals|overall|altogether|in all|source-wide|the (?:whole |entire )?(?:source|database)|not (?:yet )?(?:retrieved|loaded|shown|read|listed|counted)|unretrieved|hidden|remaining|further|additional|beyond|more|fewer|less|over|under|exceeds?|exceeding|at least|at most|up to|about|approximately|around|roughly|nearly|almost)(?![\p{L}\p{N}_-])/iu;

/** The titles and ids an element is named by: those the checked text carries for its key, or the ones its line writes. */
const namesOfKey = (key: string, assembled: CheckedText): string[] => (assembled.elementNames?.get(key) ?? titleAndIdOf((assembled.lines.get(key) ?? '').normalize('NFC'))).map((name) => name.normalize('NFC'));

/** The titles and ids of the elements sent, the longest first. */
const namesOfElements = (assembled: CheckedText): string[] => [...new Set([...assembled.lines.keys()].flatMap((key) => namesOfKey(key, assembled)))].filter((name) => name !== '').sort((first, second) => second.length - first.length);

const ESCAPED = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const BETWEEN_NAMES = '(?:[\\s,;&()]|(?<![\\p{L}\\p{N}_-])(?:and|to|through)(?![\\p{L}\\p{N}_-]))+';

/**
 * The text of a sentence outside the lists of names that belong to a count: the list that follows it (`Five accounts, AC-1 to AC-5, …`, `Five accounts (AC-1 to AC-5) …`) and the one that precedes it (`AC-1 to AC-5, five
 * accounts, …`). A list has names joined by a comma, `and`, `to` or `through`; it opens right after the type word, or after a comma or a bracket, and ends before the count with a comma or a bracket, so that a name joined to the
 * count by `to` or `and` alone (`from five accounts to AC-9`) is a subject or a target apart from it.
 */
function outsideTheList(before: string, rest: string, names: readonly string[]): string {
  if (names.length === 0) return `${before} ${rest}`;
  const name = `(?<![\\p{L}\\p{N}_-])(?:${names.map(ESCAPED).join('|')})(?![\\p{L}\\p{N}_-])`;
  const list = `${name}(?:${BETWEEN_NAMES}${name})*`;
  const following = new RegExp(`^[\\s,;:(]*${list}`, 'iu').exec(rest)?.[0].length ?? 0;
  const preceding = new RegExp(`${list}[\\s,;:)]*$`, 'iu').exec(before)?.[0].length ?? 0;
  return `${before.slice(0, before.length - preceding)} ${rest.slice(following)}`;
}

/**
 * Whether a number is the count of the elements the sentence cites that are of the type, or of the kind (entities, relationships, elements), the text after it names, less the elements of that type the sentence names
 * apart from the count, by title or id, as a subject or a target (`Five accounts, AC-1 to AC-5, paid the account AC-9` counts five of six cited accounts): the check counts the cited elements itself and invents no number. A count
 * that equals all the cited elements of the type stands too, since the number then equals what the sentence cites (`Four accounts form a cycle from AC-1 back to AC-1`: the named account is one of the four).
 */
function countsCitedElements(number: string, after: string, sentence: SummarySentence, assembled: CheckedText): boolean {
  const types = assembled.elementTypes;
  if (types === undefined || !/^\d+$/u.test(number) || OTHER_POPULATION.test(sentence.text.replace(/\s+/gu, ' '))) return false;
  const lines = new Set([...(assembled.readKeys ?? []), ...(assembled.descriptionKeys ?? [])]);
  const wanted = Number(number);
  const text = sentence.text.normalize('NFC');
  const tail = after.normalize('NFC');
  const counted = (named: string, ofType: (type: string) => boolean): boolean => {
    const end = typeWordLength(tail, named);
    if (end === undefined) return false;
    const outside = outsideTheList(text.slice(0, text.length - tail.length).replace(/\S+$/u, ''), tail.slice(end), namesOfElements(assembled));
    const matching = [...new Set(sentence.cites)].filter((key) => {
      const type = lines.has(key) ? undefined : types.get(key);
      return type !== undefined && ofType(type);
    });
    // a name that two of the cited elements share names none of them apart: it is the one name of the group the sentence counts
    const apart = (key: string): boolean => namesOfKey(key, assembled).some((name) => occursWhole(name, outside) && !matching.some((other) => other !== key && namesOfKey(other, assembled).includes(name)));
    return wanted > 0 && (matching.length === wanted || matching.filter((key) => !apart(key)).length === wanted);
  };
  const citedTypes = new Set([...new Set(sentence.cites)].flatMap((key) => (lines.has(key) || types.get(key) === undefined ? [] : [types.get(key) ?? ''])));
  return (
    [...citedTypes].some((type) => counted(elementTypeName(type), (held) => held === type)) ||
    counted('entity', (held) => !held.startsWith('relationship ')) ||
    counted('relationship', (held) => held.startsWith('relationship ')) ||
    counted('element', () => true)
  );
}

function numbersHold(sentence: SummarySentence, assembled: CheckedText, countElements: boolean): boolean {
  const stated = numbersIn(sentence.text);
  const written = countElements ? writtenNumbersIn(sentence.text, assembled) : [];
  if (stated.length === 0 && written.length === 0) return true;
  if (sentence.cites.some((cite) => assembled.unknownCountKeys.has(cite))) return false;
  const descriptions = assembled.descriptionKeys;
  const elementCites = descriptions === undefined ? sentence.cites : sentence.cites.filter((cite) => !descriptions.has(cite));
  // a sentence that cites an element holds the numbers of the element lines alone; one that cites only meanings may restate their numbers
  const numberCites = elementCites.length === 0 ? sentence.cites : elementCites;
  const numbers = countElements ? [...numberMentionsIn(sentence.text), ...written].filter((mention) => !countsCitedElements(mention.value, mention.after, sentence, assembled)).map((mention) => mention.value) : stated;
  const cited = new Set(numberCites.flatMap((cite) => [...numbersIn(assembled.lines.get(cite) ?? ''), ...writtenValuesOfLine(assembled.lines.get(cite) ?? '')]));
  if (!numbers.every((number) => cited.has(number))) return false;
  const standalone = [...numbersIn(sentence.text, true), ...written.map((number) => number.value)];
  return assembled.inexactCounts.every((count) => !standalone.includes(count.value) || sentence.text.includes(count.phrase));
}

/** The superlatives and comparatives the comparison check looks for: fixed lists of the code. "most" and "more than" are on neither: they are ordinary words of a count. */
const SUPERLATIVE = /(?<![\p{L}\p{N}_-])(?:largest|biggest|greatest|smallest|highest|lowest|maximum|minimum)(?![\p{L}\p{N}_-])/iu;
const COMPARATIVE = /(?<![\p{L}\p{N}_-])(?:larger|bigger|greater|smaller|higher|lower)(?![\p{L}\p{N}_-])/iu;

const ELEMENT_KEY = /^[ner]\d+$/;

const sameKeys = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((key) => right.includes(key));

/**
 * A sentence with a word of comparison names the larger or the largest of what it cites, so it may do so only from lines that all show what is compared. It is removed when it cites two or more elements of one type
 * (an entity type, or a relationship type) that do not all hold a value for the same properties, which are read from what the lines were written from and never from their text; and when it names the largest,
 * smallest and the like (a superlative), or cites a single element, while the text sent holds another element of that type that it does not cite, unless it also cites a line of a read that listed the element
 * (which states how many that read returned and did not show). A date does not make a line carry an amount: the properties are compared by their keys.
 */
function comparisonHolds(sentence: SummarySentence, assembled: CheckedText): boolean {
  const superlative = SUPERLATIVE.test(sentence.text);
  if (!superlative && !COMPARATIVE.test(sentence.text)) return true;
  const types = assembled.elementTypes;
  if (types === undefined) return true;
  const cited = new Map<string, string[]>();
  for (const key of new Set(sentence.cites)) {
    const type = ELEMENT_KEY.test(key) ? types.get(key) : undefined;
    if (type !== undefined) cited.set(type, [...(cited.get(type) ?? []), key]);
  }
  const reads = sentence.cites.filter((key) => key.startsWith('s') && assembled.readKeys?.has(key) === true);
  // the types compared are those whose cited lines hold a number the sentence states; with no number stated, those with two or more cited elements; with none of those, every type: an element of another type is context
  const stated = new Set(numbersIn(sentence.text));
  const holdsStated = (keys: readonly string[]): boolean => keys.some((key) => numbersIn(assembled.lines.get(key) ?? '').some((number) => stated.has(number)));
  const byNumber = [...cited].filter(([, keys]) => stated.size > 0 && holdsStated(keys)).map(([type]) => type);
  const byCount = [...cited].filter(([, keys]) => stated.size === 0 && keys.length >= 2).map(([type]) => type);
  const compared = new Set(byNumber.length > 0 ? byNumber : byCount.length > 0 ? byCount : [...cited.keys()]);
  for (const [type, keys] of cited) {
    const [first] = keys;
    if (first === undefined || !compared.has(type)) continue;
    const shown = (key: string): readonly string[] => assembled.propertyKeys?.get(key) ?? [];
    if (keys.length >= 2 && !keys.every((key) => sameKeys(shown(key), shown(first)))) return false;
    if (!superlative && keys.length !== 1) continue;
    const others = [...types].filter(([key, other]) => ELEMENT_KEY.test(key) && other === type && !keys.includes(key));
    const excused = reads.some((read) => keys.every((key) => assembled.readElements?.get(read)?.includes(key) === true));
    if (others.length > 0 && !excused) return false;
  }
  return true;
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
  const toldWords = new Set(assembled.knownWords ?? []);
  const ordinary = ordinaryWords(assembled);
  const sentTokens = identifierTokens(sent);
  const text = sentence.text.normalize('NFC');
  for (const quoted of text.matchAll(QUOTED)) if (!occursWhole(quoted[1] ?? '', sent)) return false;
  // a decimal point between digits is not the end of a sentence: it is taken out so that what follows is not read as the start of one
  const unquoted = text.replace(QUOTED, ' ').replace(/(\d)\.(\d)/gu, '$1 $2');
  for (const token of unquoted.match(IDENTIFIER_LIKE) ?? []) {
    // a word joined with underscores between letters or digits is one name (a relationship type): it is found whole in the text sent, never as a mix of the parts of others; Markdown emphasis around a word is not one
    if (!sentTokens.has(token) && token.split('-').some((part) => /[\p{L}\p{N}]_[\p{L}\p{N}]/u.test(part) && !known.has(part.replace(/^_+|_+$/gu, '').toLowerCase()))) return false;
    if (!/\d/.test(token) || !/[\p{L}_-]/u.test(token)) continue;
    if (!sentTokens.has(token)) return false;
  }
  // a key of a property written with a capital inside (`paidValue`) is a name the text sent gave when it holds that word whole: its capital is not the start of a name
  const withoutIdentifiers = unquoted.replace(IDENTIFIER_LIKE, (token) => (/\d/.test(token) || (/\p{Ll}\p{Lu}/u.test(token) && sentTokens.has(token)) ? ' '.repeat(token.length) : token));
  const countedWords = writtenNumbersIn(unquoted, assembled).filter((number) => number.counting);
  const withoutCountWords = countedWords.reduce((blanked, counted) => blanked.slice(0, counted.index) + ' '.repeat(counted.length) + blanked.slice(counted.index + counted.length), withoutIdentifiers);
  for (const found of withoutCountWords.matchAll(CAPITALISED)) {
    const lower = found[0].toLowerCase();
    if (STRUCTURAL_VOCABULARY.has(lower) || known.has(lower) || toldWords.has(lower)) continue;
    const opensSentence = /(^\s*|[.!?]\s+)$/u.test(withoutCountWords.slice(0, found.index));
    if (opensSentence && ordinaryOpener(lower, ordinary)) continue;
    return false;
  }
  return true;
}

const KEY = '[nerastm]\\d+';
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

/** Whether a sentence states a number for a count that is not known, or the number of an estimated or lower-bound count without the phrase that labels it. */
function breaksCountRule(sentence: SummarySentence, assembled: CheckedText): boolean {
  const written = writtenNumbersIn(sentence.text, assembled);
  if (numbersIn(sentence.text).length === 0 && written.length === 0) return false;
  if (sentence.cites.some((cite) => assembled.unknownCountKeys.has(cite))) return true;
  const standalone = [...numbersIn(sentence.text, true), ...written.map((number) => number.value)];
  return assembled.inexactCounts.some((count) => standalone.includes(count.value) && !sentence.text.includes(count.phrase));
}

function removalReasonOf(sentence: SummarySentence, assembled: CheckedText, countElements: boolean): RemovalReason {
  if (!citationsHold(sentence, assembled)) return 'citation';
  if (!numbersHold(sentence, assembled, countElements)) return breaksCountRule(sentence, assembled) ? 'count' : 'number';
  if (!comparisonHolds(sentence, assembled)) return 'comparison';
  return 'name';
}

/** Keeps the sentences that cite real elements, hold only the numbers of the elements they cite and the ids, quoted texts and capitalised words the text sent holds, and state no verdict, with the keys of the elements taken out of their text; counts each removed sentence once. */
export function judgeSentences(sentences: readonly SummarySentence[], input: CheckedText, options: { readonly tableRows?: boolean } = {}): Judged {
  const assembled = options.tableRows === true ? { ...input, readWordNumbers: false } : input;
  const kept: SummarySentence[] = [];
  const rejected: RejectedSentence[] = [];
  let removed = 0;
  let verdictFound = false;
  let keysStripped = 0;
  let keysRemoved = 0;
  for (const original of sentences) {
    if (holdsVerdict(original, assembled)) {
      verdictFound = true;
      removed += 1;
      rejected.push({ text: original.text, reason: 'verdict' });
      continue;
    }
    const clean = withoutKeys(original.text, assembled);
    if (clean === undefined) {
      removed += 1;
      keysRemoved += 1;
      rejected.push({ text: original.text, reason: 'key' });
      continue;
    }
    const sentence = clean.stripped ? { ...original, text: clean.text } : original;
    if (!citationsHold(sentence, assembled) || !numbersHold(sentence, assembled, options.tableRows !== true) || !comparisonHolds(sentence, assembled) || !namesHold(sentence, namesScopeOf(sentence, assembled))) {
      removed += 1;
      rejected.push({ text: original.text, reason: removalReasonOf(sentence, assembled, options.tableRows !== true) });
    } else {
      kept.push(sentence);
      if (clean.stripped) keysStripped += 1;
    }
  }
  return { kept, removed, rejected, verdictFound, keysStripped, keysRemoved };
}

export interface JudgeInput {
  readonly sentences: readonly SummarySentence[];
  readonly text: CheckedText;
  /** True when the sentences are the rows of a table: a number in a cell must be in a cited line, whatever the cited elements number. */
  readonly tableRows?: boolean;
}

/** The check as a worker thread runs it: one argument, since a worker is handed one value. */
export function judgeInput(input: JudgeInput): Judged {
  return judgeSentences(input.sentences, input.text, { tableRows: input.tableRows === true });
}

export const JUDGE_MODULE: CheckModule = { url: new URL('./reply-checks.js', import.meta.url).href, exportName: 'judgeInput' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isSentence = (value: unknown): value is SummarySentence => isRecord(value) && typeof value['text'] === 'string' && Array.isArray(value['cites']) && value['cites'].every((cite) => typeof cite === 'string');

const isRejected = (value: unknown): value is RejectedSentence => isRecord(value) && typeof value['text'] === 'string' && isRemovalReason(value['reason']);

/** Reads the result a worker sent back; undefined for anything that is not the result of the check. */
export function parseJudged(value: unknown): Judged | undefined {
  if (!isRecord(value) || !Array.isArray(value['kept']) || !value['kept'].every(isSentence)) return undefined;
  const { removed, rejected, keysStripped, keysRemoved, verdictFound } = value;
  if (typeof removed !== 'number' || typeof keysStripped !== 'number' || typeof keysRemoved !== 'number' || typeof verdictFound !== 'boolean') return undefined;
  if (!Array.isArray(rejected) || !rejected.every(isRejected) || rejected.length !== removed) return undefined;
  return { kept: value['kept'], removed, rejected, keysStripped, keysRemoved, verdictFound };
}
