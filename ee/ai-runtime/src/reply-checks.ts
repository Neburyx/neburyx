import type { SummarySentence } from '@neburyx/contracts';
import type { CheckModule } from './check-runner.js';

/** An entity an element is or joins: its entity type and its stable id. */
export type EntityEnd = readonly [type: string, id: string];

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
  /** The entities each element stands for or joins, as pairs of an entity type and a stable id, by the element's key: an entity is itself, a relationship is its two ends. A count of the entities of a type that the sentence cites through the relationships that end at them is verified from these. */
  readonly elementEnds?: ReadonlyMap<string, readonly EntityEnd[]>;
  /** The properties of each element a ranking may rest on, by the element's key (see `RankedProperty`): plain text and data, so that it crosses to a worker thread. */
  readonly rankedValues?: ReadonlyMap<string, readonly RankedProperty[]>;
  /** The value of each property as it was sent to the model, by the element's key, a masked value as its mask: what a claim that elements differ, are the same or share something is tested against. */
  readonly elementValues?: ReadonlyMap<string, readonly { readonly key: string; readonly text: string; readonly masked: boolean }[]>;
}

/** The cardinals from two to twelve, as a pattern: the numbers a sentence points at a few with. */
const CARDINAL_WORDS = 'two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';

const NUMBER_TOKEN = /[-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)/g;
const TOKEN = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;
const IDENTIFIER_LIKE = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;
const QUOTED = /"([^"]+)"/g;
const CAPITALISED = /\p{Lu}[\p{L}]*/gu;

/** The ordinary words a sentence may start with or hold in a capital without naming anything: articles, determiners, small number words, prepositions and conjunctions: language, never a word of a domain. The words of a domain (a shape of a typology, a type) come from the text sent and the instructions the model was given. */
const STRUCTURAL_VOCABULARY: ReadonlySet<string> = new Set([
  'i', 'the', 'a', 'an', 'any', 'this', 'that', 'these', 'those', 'both', 'each', 'every', 'all', 'no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'several', 'some', 'many', 'few',
  'another', 'other', 'it', 'its', 'they', 'them', 'their', 'we', 'our', 'there', 'here', 'at', 'in', 'on', 'of', 'by', 'for', 'from', 'with', 'to', 'and', 'or', 'but', 'as', 'is', 'are', 'was', 'were', 'also', 'between', 'within',
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

/** The longest sentence that is checked, in characters: ten times the longest the recorded answers hold. */
const LONGEST_SENTENCE = 4000;

export const REMOVAL_REASONS = ['verdict', 'key', 'citation', 'number', 'count', 'comparison', 'name', 'label', 'cell', 'row', 'length'] as const;
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
  const ended = [...(assembled.elementEnds?.values() ?? [])].flatMap((ends) => ends.map(([type]) => elementTypeName(`entity ${type}`)));
  const types = assembled.elementTypes === undefined ? [] : [...new Set([...assembled.elementTypes.values()].map(elementTypeName)), ...new Set(ended), 'entity', 'relationship', 'element'];
  const outside = text.replace(QUOTED, (quoted) => ' '.repeat(quoted.length));
  return [...outside.matchAll(NUMBER_WORD)].flatMap((found) => {
    const value = numberWordValue(found[0]);
    const after = text.slice(found.index + found[0].length);
    // `no two widgets share an owner`: a pair of the set, not a count of what is cited
    // only the words just before are read: the whole text before each number would make a long reply take time that grows with the square of its length
    const pairwise = /(?<![\p{L}\p{N}_-])(?:no|any)\s+$/iu.test(text.slice(Math.max(0, found.index - 60), found.index));
    const counting = !pairwise && /^\s+\S/u.test(after) && types.some((name) => namesType(after.trimStart(), name));
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
  // the entities that the cited elements are or join (a relationship that ends at an entity counts that entity once): a count through a relationship is exact when it equals how many distinct entities of the type there are among the cited ends, and no name is adjusted for
  const endsCited = sentence.cites.filter((key) => !lines.has(key)).flatMap((key) => assembled.elementEnds?.get(key) ?? []);
  const endsOf = (ofType: (entityType: string) => boolean): Set<string> => new Set(endsCited.filter(([type]) => ofType(type)).map(([type, id]) => `${type}\u0000${id}`));
  const citedEntities = (ofType: (entityType: string) => boolean): number => new Set([...sentence.cites].filter((key) => !lines.has(key) && types.get(key)?.startsWith('entity ') === true && ofType((types.get(key) ?? '').slice('entity '.length)))).size;
  // the cited relationships bring in entities that are not cited themselves: the ends are then the only population, and a count of the cited entities says nothing of them
  // a cited entity with no end data of its own leaves the population unknown: no count of entities is verified, so that no smaller count is kept
  const unknownEnds = assembled.elementEnds !== undefined && [...sentence.cites].some((key) => !lines.has(key) && types.get(key)?.startsWith('entity ') === true && assembled.elementEnds?.get(key) === undefined);
  const joinsMore = (ofType: (entityType: string) => boolean): boolean => unknownEnds || endsOf(ofType).size > citedEntities(ofType);
  const entityTypes = new Set(endsCited.map(([type]) => type));
  const countedEnds = (entityType: string): boolean => {
    const end = typeWordLength(tail, elementTypeName(`entity ${entityType}`));
    return !unknownEnds && end !== undefined && wanted > 0 && endsOf((type) => type === entityType).size === wanted;
  };
  const allEnds = endsOf(() => true);
  return (
    [...entityTypes].some(countedEnds) ||
    [...citedTypes].some((type) => !(type.startsWith('entity ') && joinsMore((entityType) => entityType === type.slice('entity '.length))) && counted(elementTypeName(type), (held) => held === type)) ||
    (!unknownEnds && typeWordLength(tail, 'entity') !== undefined && wanted > 0 && allEnds.size === wanted) ||
    (!joinsMore(() => true) && counted('entity', (held) => !held.startsWith('relationship '))) ||
    counted('relationship', (held) => held.startsWith('relationship ')) ||
    counted('element', () => true)
  );
}

const INSTANT_IN_TEXT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?/gu;
/** A date, a time of day or an instant as a sentence writes it. */
const TEMPORAL_LITERAL_IN_TEXT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?|\d{4}-\d{2}-\d{2}|(?<![\d:])\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?(?![\d:])/gu;

/** The parts of an instant a sentence may write for it, each an exact part of what the line holds and no rounding: the instant, its date, its time with or without the zone, and its hours and minutes when the seconds are nothing. */
function partsOfInstant(instant: string): string[] {
  const time = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/u.exec(instant.slice(11));
  if (time === null) return [instant, instant.slice(0, 10)];
  const [, hours = '', minutes = '', seconds = '', fraction = '', zone = ''] = time;
  const parts = [instant, instant.slice(0, 10), instant.slice(11), `${hours}:${minutes}:${seconds}${fraction}`];
  if (fraction === '') parts.push(`${hours}:${minutes}:${seconds}${zone}`, ...(seconds === '00' ? [`${hours}:${minutes}${zone}`, `${hours}:${minutes}`] : []));
  return parts;
}

/** Whether a date, a time or an instant written in a sentence is an exact part of an instant that one of the lines holds. */
const isTemporalPartOf = (literal: string, lines: readonly string[]): boolean => lines.some((line) => [...line.matchAll(INSTANT_IN_TEXT)].some((found) => partsOfInstant(found[0]).includes(literal)));

/** The sentence with the dates and times it writes as exact parts of the instants of the cited lines blanked to the same length: they are no numbers to find on a line, and positions stay. */
function withoutTemporalParts(text: string, lines: readonly string[]): string {
  return text.replace(TEMPORAL_LITERAL_IN_TEXT, (found) => (isTemporalPartOf(found, lines) ? ' '.repeat(found.length) : found));
}

function numbersHold(sentence: SummarySentence, assembled: CheckedText, countElements: boolean): boolean {
  // a date or a time that is an exact part of an instant of a cited line is judged with the instant, not as numbers
  const scanned = withoutTemporalParts(sentence.text, sentence.cites.map((cite) => assembled.lines.get(cite) ?? ''));
  const stated = numbersIn(scanned);
  const written = countElements ? writtenNumbersIn(sentence.text, assembled) : [];
  if (stated.length === 0 && written.length === 0) return true;
  if (sentence.cites.some((cite) => assembled.unknownCountKeys.has(cite))) return false;
  const descriptions = assembled.descriptionKeys;
  const elementCites = descriptions === undefined ? sentence.cites : sentence.cites.filter((cite) => !descriptions.has(cite));
  // a sentence that cites an element holds the numbers of the element lines alone; one that cites only meanings may restate their numbers
  const numberCites = elementCites.length === 0 ? sentence.cites : elementCites;
  const numbers = countElements ? [...numberMentionsIn(scanned), ...written].filter((mention) => !countsCitedElements(mention.value, mention.after, sentence, assembled)).map((mention) => mention.value) : stated;
  const cited = new Set(numberCites.flatMap((cite) => [...numbersIn(assembled.lines.get(cite) ?? ''), ...writtenValuesOfLine(assembled.lines.get(cite) ?? '')]));
  if (!numbers.every((number) => cited.has(number))) return false;
  const standalone = [...numbersIn(scanned, true), ...written.map((number) => number.value)];
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
function comparedElementsHold(sentence: SummarySentence, assembled: CheckedText): boolean {
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
    const scope = scopeOf(sentence, assembled, type);
    const others = [...types].filter(([key, other]) => ELEMENT_KEY.test(key) && other === type && !keys.includes(key) && (scope === undefined || scope.keys.includes(key)));
    const excused = reads.some((read) => keys.every((key) => assembled.readElements?.get(read)?.includes(key) === true));
    if (others.length > 0 && !excused) return false;
  }
  return true;
}

/** The sentence without its quoted spans: a quoted title is a name the name check judges, and is no claim. */
const withoutQuoted = (text: string): string => text.normalize('NFC').replace(QUOTED, (quoted) => ' '.repeat(quoted.length));

/** A text as words, lower case: the capitals inside a key and the underscores are word breaks, so that `amountValue`, `amount_value` and `amount value` are one phrase. */
const flatten = (text: string): string => text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').replaceAll('_', ' ').toLowerCase().replace(/\s+/gu, ' ');

/** The clause of a text that holds a position. */
const clauseAt = (text: string, at: number): string => {
  const start = Math.max(text.lastIndexOf(',', at), text.lastIndexOf(';', at), text.lastIndexOf('.', at), text.lastIndexOf(' but ', at), -1) + 1;
  const ends = [',', ';', '.', ' but '].map((mark) => text.indexOf(mark, at)).filter((end) => end >= 0);
  return text.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
};

/** The clauses of a sentence: its punctuation and the words that turn it. */
const clausesOf = (text: string): string[] => text.split(/[.;:!?,]+|(?<![\p{L}\p{N}_-])(?:but|and yet|although)(?![\p{L}\p{N}_-])/iu).filter((clause) => clause.trim() !== '');

const NEGATION = /(?<![\p{L}\p{N}_-])(?:no|none|not|never|without|cannot|nothing)(?![\p{L}\p{N}_-])|n['\u2019]t(?![\p{L}])/iu;
const PRESENCE_WORDS = '(?:in view|in the view|on screen|shown|show|shows|listed|lists?|appears?|named|visible|present|holds?|held|loaded|read|returned|returns?|given|provided|stated|reported|recorded|found|available|included)';
/** A negation followed within a few words by a word of presence: the sentence says something is absent or not shown. Words of the language, never of a domain. */
const BETWEEN = '(?:\\s+(?!(?:and|or|but)(?![\\p{L}\\p{N}_-]))\\S+){0,4}?';
const ABSENT_CLAUSE = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:no|none|not|never|without|cannot|nothing)(?![\\p{L}\\p{N}_-])${BETWEEN}\\s+${PRESENCE_WORDS}(?![\\p{L}\\p{N}_-])|n['\\u2019]t${BETWEEN}\\s+${PRESENCE_WORDS}(?![\\p{L}\\p{N}_-])|(?<![\\p{L}\\p{N}_-])(?:shows?|lists?|holds?|contains?|has|have|names?)\\s+(?:\\S+\\s+){0,2}?(?:no|none)(?![\\p{L}\\p{N}_-])`, 'iu');

/** The kinds of element, which are words of the product and of no domain, with the forms a sentence uses. */
const KIND_FORMS: readonly (readonly [string, RegExp])[] = [
  ['relationship', /relationships?|links?/iu],
  ['entity', /entit(?:y|ies)/iu],
  ['element', /elements?/iu],
];

const PLACE_PREPOSITION = '(?:between|among|amongst|across|within)';

/** What a line of the server states about a kind: the number shown, from `<n> relationships shown`, and `no relationship listed`. */
function statedOfKind(line: string, forms: RegExp, kind: string): number | undefined {
  const shown = new RegExp(`(\\d+) (?:${forms.source}) shown`, 'iu').exec(line);
  if (shown?.[1] !== undefined) return Number(shown[1]);
  return kind === 'relationship' && /no relationship listed/iu.test(line) ? 0 : undefined;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** A pattern for a flattened word or phrase, in its singular or its plural: the plural is made of the word, then each part is escaped. */
function termPattern(word: string): string {
  const escape = (part: string): string => escapeRegex(part).replace(/ /gu, '\\s+');
  return word.endsWith('y') ? `(?:${escape(word)}|${escape(word.slice(0, -1))}ies)` : `${escape(word)}(?:s|es)?`;
}

/** Whether a term (a type, a kind, or a property key as words) occurs in a text as a whole word or phrase, in its singular or its plural; both are flattened alike. */
function termIn(term: string, text: string): boolean {
  const word = flatten(term).trim();
  if (word === '') return false;
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${termPattern(word)}(?![\\p{L}\\p{N}_-])`, 'iu').test(flatten(text));
}

/** The types of the elements sent, by their words, with their kind. */
const typesSent = (assembled: CheckedText): { readonly type: string; readonly word: string }[] => [...new Set(assembled.elementTypes?.values() ?? [])].map((type) => ({ type, word: flatten(type.replace(/^(?:entity|relationship) /u, '')).trim() }));

/** Whether a clause denies a type outright (`no gadgets are shown`, `gadgets are not in view`), as against denying what is related to it (`the receiving gadgets are not shown`). */
function deniesOutright(word: string, clause: string): boolean {
  const noun = termPattern(word);
  return new RegExp(`(?<![\\p{L}\\p{N}_-])(?:no|none|without)\\s+(?:(?:any|other)\\s+)?${noun}(?![\\p{L}\\p{N}_-])|(?<![\\p{L}\\p{N}_-])${noun}\\s+(?:are|is)\\s+not\\s+(?:shown|in view|listed)`, 'iu').test(clause);
}

/**
 * A sentence that says something is absent or not shown rests on a line of the server (a read, or the coverage of the view), because no element can hold an absence. What it says is absent is checked against that line: a kind
 * (relationship, entity, element) needs a cited line that states none of it, and a line that states some refuses it; a type is refused by a cited read that listed an element of it.
 */
function absenceHolds(sentence: SummarySentence, assembled: CheckedText): boolean {
  const absent = clausesOf(withoutQuoted(sentence.text)).filter((clause) => ABSENT_CLAUSE.test(clause));
  if (absent.length === 0) return true;
  const served = sentence.cites.filter((cite) => assembled.readKeys?.has(cite) === true);
  if (served.length === 0) return false;
  for (const clause of absent) {
    const negation = Math.max(0, clause.search(NEGATION));
    // a clause that names no kind but after a place word (`nothing is shown among the relationships`) denies that kind
    const placeOnly = !KIND_FORMS.some(([, forms]) => new RegExp(`(?<![\\p{L}\\p{N}_-])(?<!${PLACE_PREPOSITION}\\s+(?:(?:the|these|those|its|their)\\s+)?)(?:${forms.source})(?![\\p{L}\\p{N}_-])`, 'iu').test(clause.slice(negation)));
    for (const [kind, forms] of KIND_FORMS) {
      // a kind after a preposition is the place of what is denied (`no relationship is given between the elements`), not what is denied
      const named = new RegExp(`(?<![\\p{L}\\p{N}_-])${placeOnly ? '' : `(?<!${PLACE_PREPOSITION}\\s+(?:(?:the|these|those|its|their)\\s+)?)`}(?:${forms.source})(?![\\p{L}\\p{N}_-])`, 'iu').test(clause.slice(negation));
      // a kind that is the subject of the negation (`relationships are not shown`) is what is denied; one before a verb (`the elements do not show`) only looks
      const subject = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${forms.source})\\s+(?:(?:are|is)\\s+)?$`, 'iu').test(clause.slice(0, negation));
      if (!named && !subject) continue;
      const stated = served.flatMap((cite) => statedOfKind(assembled.lines.get(cite) ?? '', forms, kind) ?? []);
      if (stated.length === 0 || stated.some((count) => count > 0)) return false;
    }
    const aboutRead = READ_NOUN.test(flatten(clause));
    for (const { type, word } of typesSent(assembled)) {
      if (!deniesOutright(word, flatten(clause))) continue;
      const scope = aboutRead ? served.flatMap((cite) => assembled.readElements?.get(cite) ?? []) : [...(assembled.elementTypes?.keys() ?? [])].filter((key) => assembled.readKeys?.has(key) !== true);
      if (scope.some((key) => assembled.elementTypes?.get(key) === type)) return false;
    }
  }
  return true;
}

/** The keys of the cited elements, those of the lines of a read or a meaning left out. */
function citedElements(sentence: SummarySentence, assembled: CheckedText): string[] {
  const lines = new Set([...(assembled.readKeys ?? []), ...(assembled.descriptionKeys ?? [])]);
  return [...new Set(sentence.cites)].filter((key) => !lines.has(key) && assembled.elementTypes?.has(key) === true);
}

/** The elements of one type that a sentence limits itself to, as the checks of a ranking and of a comparison can verify: the set, and the sentence with the names of an enumerated list blanked. */
interface Scope {
  readonly type: string;
  readonly keys: readonly string[];
  readonly outside?: string;
}

const LIST_INTRO = '(?:of|among|amongst|between|out of)\\s+(?:(?:the|these|those)\\s+)?(?:[\\p{L}\\p{N}_-]+\\s+){0,2}?';

/** The words between two positions of a text, nothing when a mark of the end of a clause, or a word that joins another clause (`and`, `but`, `while`, `whereas`, `or`), stands between them. */
function wordsBetween(text: string, from: number, to: number): number | undefined {
  const between = text.slice(from, to);
  if (/[.;:!?]/u.test(between) || /(?<![\p{L}\p{N}_-])(?:and|but|while|whereas|or)(?![\p{L}\p{N}_-])/iu.test(between)) return undefined;
  return (between.match(/[\p{L}\p{N}_-]+/gu) ?? []).length;
}

/** Whether a stretch of a sentence (a list of names, a phrase of a read) stands at a ranking word: after it with at most `after` words between, or before it with at most `before`, in the same clause. A stretch elsewhere (`the sender of A and B`) limits nothing the ranking says. */
function standsAtRanking(unnamed: string, start: number, end: number, after: number, before: number): boolean {
  return rankingWordsIn(unnamed).some((claim) => {
    const following = wordsBetween(unnamed, claim.end, start);
    const preceding = wordsBetween(unnamed, end, claim.index);
    return (claim.end <= start && following !== undefined && following <= after) || (claim.index >= end && preceding !== undefined && preceding <= before);
  });
}

/** What may follow a set a ranking is limited to (a list, a read): the end of a clause, the figure claimed, or the verb that names the holder. Another noun phrase, `and the rest`, `or any widget in the view` widens the set. */
const CLOSES_A_SET = /^\s*(?:$|[,.;]|[-+]?\d|(?:is|are|was|were|has|have|had|belongs|goes)(?![\p{L}\p{N}_-]))/iu;

/** Words after a scope that open or add another set (`and of the rest`, `as in the view`, `more than any`, `elsewhere`): the set the sentence limited itself to is then widened. What follows a scope is the figure, a name and linking words. */
const WIDENS_AFTER = /(?<![\p{L}\p{N}_-])(?:and|or|as|also|too|plus|elsewhere|rest|others|remaining|than|more|whole|entire|everywhere|any|all|every|each|throughout|including|of|among|across|within|in|from)(?![\p{L}\p{N}_-])/iu;

/** A list at the ranking, in one of two fixed forms: after the ranking word (`the latest of A, B and C`, a property between, at most three words) and closed as a set; or opening the sentence (`Among A, B and C, C has the largest`), closed by a comma, with nothing after the ranking that opens another set. */
const attachedToRanking = (unnamed: string, listStart: number, listEnd: number): boolean => {
  const opening = unnamed.slice(0, listStart).trim() === '';
  const closed = /^\s*,/u.test(unnamed.slice(listEnd));
  const after = rankingWordsIn(unnamed).some((claim) => claim.end <= listStart && (wordsBetween(unnamed, claim.end, listStart) ?? Infinity) <= 3);
  if (after) return CLOSES_A_SET.test(unnamed.slice(listEnd)) && !WIDENS_AFTER.test(unnamed.slice(listEnd));
  return opening && closed && standsAtRanking(unnamed, listStart, listEnd, 0, 5) && !WIDENS_AFTER.test(unnamed.slice(listEnd));
};

/**
 * A sentence that names the set it ranks or compares in full (`the latest of A, B and C is B`) is about that set and says nothing of the other elements of the type. The set is the elements named in a list that follows `of`, `among`
 * or `between`, when each name of the list is of a cited element of one type, and there are two or more.
 */
function enumeratedScope(sentence: SummarySentence, assembled: CheckedText): Scope | undefined {
  const types = assembled.elementTypes;
  const names = namesOfElements(assembled);
  if (types === undefined || names.length === 0) return undefined;
  const text = sentence.text.normalize('NFC');
  const name = `(?<![\\p{L}\\p{N}_-])(?:${names.map(ESCAPED).join('|')})(?![\\p{L}\\p{N}_-])`;
  const found = new RegExp(`(?<![\\p{L}\\p{N}_-])${LIST_INTRO}(${name}(?:${BETWEEN_NAMES}${name})+)`, 'iu').exec(text);
  const whole = found?.[1];
  if (found === null || whole === undefined) return undefined;
  const first = found.index + found[0].length - whole.length;
  // a list names each element once: a name that comes again is the subject of what follows (`Among A, B and C, C has the largest`), not a member
  const seen = new Set<string>();
  const repeat = [...whole.matchAll(new RegExp(name, 'giu'))].find((mention) => seen.size === seen.add(mention[0].toLowerCase()).size);
  const list = repeat === undefined ? whole : whole.slice(0, repeat.index).replace(/[\s,;&()]*(?:(?:and|to|through)\s*)?$/iu, '');
  if (!attachedToRanking(text.replace(new RegExp(name, 'giu'), (mention) => ' '.repeat(mention.length)), found.index, first + list.length)) return undefined;
  const lines = new Set([...(assembled.readKeys ?? []), ...(assembled.descriptionKeys ?? [])]);
  const cited = [...new Set(sentence.cites)].filter((key) => ELEMENT_KEY.test(key) && !lines.has(key) && types.has(key));
  const listed = cited.filter((key) => namesOfKey(key, assembled).some((own) => own !== '' && occursWhole(own, list)));
  const kinds = new Set(listed.map((key) => types.get(key)));
  const [type] = kinds;
  if (type === undefined || kinds.size !== 1 || listed.length < 2) return undefined;
  const everyNameIsOfOne = [...list.matchAll(new RegExp(name, 'giu'))].every((mention) => listed.some((key) => namesOfKey(key, assembled).some((own) => own.toLowerCase() === mention[0].toLowerCase())));
  if (!everyNameIsOfOne) return undefined;
  return { type, keys: listed, outside: `${text.slice(0, first)}${' '.repeat(list.length)}${text.slice(first + list.length)}` };
}

const NOUN_RUN = String.raw`(?:(?!(?:not|besides|except|excluding|excluded|apart|other|others|without|outside|beyond|but)(?![\p{L}\p{N}_-]))[\p{L}\p{N}_-]+\s+){0,3}?`;
const READ_END = String.raw`(?:read|reads|result|results)(?![\p{L}\p{N}_-])`;
const READ_SET = String.raw`(?:the|these|those)\s+${NOUN_RUN}(?:(?:shown|listed|found|returned)\s+)?in\s+the\s+${READ_END}`;
const READ_SET_SHOWN = String.raw`(?:the|these|those)\s+${NOUN_RUN}the\s+(?:read|reads|result|results)\s+(?:shows?|lists?|listed|returned|returns?|found)(?![\p{L}\p{N}_-])`;

/**
 * Whether a sentence limits its ranking to what a read listed, in one of two fixed forms: `the largest <property> among the <nouns> in the read` (the ranking word, then `of`, `among` or `out of` and the set the read listed), or an opening
 * `Among the <nouns> the read shows, <the ranking clause>`. A read phrase anywhere else (after the figure, in an earlier clause, describing the element) limits nothing, and the ranking is over every element of the type.
 */
function readLimited(spoken: string): boolean {
  const after = new RegExp(String.raw`(?<![\p{L}\p{N}_-])(?:of|among|out of)\s+${READ_SET}`, 'iu').exec(spoken);
  if (after !== null && standsAtRanking(spoken, after.index, after.index + after[0].length, 3, -1) && CLOSES_A_SET.test(spoken.slice(after.index + after[0].length)) && !WIDENS_AFTER.test(spoken.slice(after.index + after[0].length))) return true;
  const property = new RegExp(String.raw`(?<![\p{L}\p{N}_-])in\s+the\s+${READ_END}`, 'iu').exec(spoken);
  if (property !== null && standsAtRanking(spoken, property.index, property.index + property[0].length, 1, -1) && CLOSES_A_SET.test(spoken.slice(property.index + property[0].length)) && !WIDENS_AFTER.test(spoken.slice(property.index + property[0].length))) return true;
  const opening = new RegExp(String.raw`^\s*(?:(?:of|among)\s+(?:${READ_SET}|${READ_SET_SHOWN})|in\s+the\s+${READ_END})\s*,`, 'iu').exec(spoken);
  return opening !== null && standsAtRanking(spoken, 0, opening[0].length, -1, 5) && !WIDENS_AFTER.test(spoken.slice(opening[0].length));
}

/**
 * A sentence that limits itself to a read (`in the read`, `the read shows`) and cites every element of the type that the read listed is about what that read listed: a ranking or a comparison of it is judged over those elements,
 * not over the elements of the type that other reads and the view hold. Only when one read does so: with two, the read the sentence means is not known.
 */
function readScope(sentence: SummarySentence, assembled: CheckedText, type: string): Scope | undefined {
  const types = assembled.elementTypes;
  if (types === undefined) return undefined;
  const cited = new Set(sentence.cites);
  // an element's own title may hold the word `read`: what names an element is no mention of a read
  const unnamed = namesOfElements(assembled).reduce((text, name) => text.replace(new RegExp(`${WB}${ESCAPED(name)}${WE}`, 'giu'), (found) => ' '.repeat(found.length)), sentence.text.normalize('NFC'));
  const spoken = withoutQuoted(unnamed);
  const limited = readLimited(spoken);
  const matching = [...(assembled.readElements ?? [])].flatMap(([read, listed]) => {
    const members = listed.filter((key) => types.get(key) === type);
    return /^s\d+$/u.test(read) && members.length > 0 && members.every((key) => cited.has(key)) && limited ? [members] : [];
  });
  const [only] = matching;
  return matching.length === 1 && only !== undefined ? { type, keys: only } : undefined;
}

/** The set a sentence limits a ranking or a comparison of the elements of a type to, when it does so in a way that can be checked. */
const scopeOf = (sentence: SummarySentence, assembled: CheckedText, type: string): Scope | undefined => {
  const listed = enumeratedScope(sentence, assembled);
  return listed?.type === type ? listed : readScope(sentence, assembled, type);
};

const QUANTIFIER_BEFORE = /(?<![\p{L}\p{N}_-])(?:all|every|each|none)(?:\s+of)?(?:\s+(?:the|these|those))?\s+(?:\S+\s+)?(?:(?:,\s*(?:(?:and|or)\s+)?|(?:and|or)\s+)(?:the\s+)?(?:\S+\s+)?)*$/iu;
/** `only <type>` before a place or a verb of showing (`only widgets are shown`, `the only widget in view`) says what the elements of a type are; `only` that a relation restricts (`sent only to`, `the only widget linked to it`) is relative and says nothing of the whole type. */
const ONLY_BEFORE = /(?<![\p{L}\p{N}_-])only\s+(?:\S+\s+)?$/iu;
const ONLY_PLACE_AFTER = /^\s+(?:\S+\s+){0,2}?(?:shown|in view|on screen|in the view|on the screen|listed|read|returned|here|present|visible|available|given|held|loaded)(?![\p{L}\p{N}_-])/iu;
/** `the only <type>` says there is one: it is checked against the set as `all` is, and the set must hold one element. */
const ONLY_ONE_BEFORE = /(?<![\p{L}\p{N}_-])the\s+only\s+(?:\S+\s+)?$/iu;
const DEFINITE_BEFORE = /(?<![\p{L}\p{N}_-])the\s+(?:\S+\s+)?$/iu;
/** A quantifier that stands right after the noun it speaks of (`transactions are each shown`, `transactions all carry`, `transactions in view, all with …`): what follows the noun is a place, a verb of being or having, and the quantifier, nothing else. */
const FLOATING_AFTER = /^(?:\s+(?:in view|on screen|in the view|on the screen))?(?:\s+(?:are|were|is|have|has|had|share|shares|carry|carries|hold|holds|show|shows))?(?:\s*,)?\s+(?:all|each)(?![\p{L}\p{N}_-])/iu;
const CARDINAL = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)(?:-\\S+)?';
/** The noun opens the sentence, as its subject: before it only a place and `the`, and one more word that is no number, article or determiner of a part of the set. */
const SUBJECT_BEFORE = new RegExp(`^\\s*(?:(?:in view|on screen|in the view|on the screen|here)\\s*,?\\s*)?(?:the\\s+)?(?:(?!(?:\\d|${CARDINAL}|a|an|several|some|many|few|both|these|those|no|other|another|most|half)(?![\\p{L}\\p{N}_-]))\\S+\\s+)?$`, 'iu');
const PLACE_AFTER = /^\s+(?:\S+\s+){0,1}?(?:on screen|in view|on the screen|in the view)(?![\p{L}\p{N}_-])/iu;

/** A negation directly before `all`, `every` or `each`, or before a verb of holding or covering that leads to it, with only the noun phrase of the set after (a determiner, a possessive, two words at most): the sentence denies that something is so of the whole set. A word that opens another assertion, or another quantifier, ends it. */
const DENIED_ALL = /(?:(?<![\p{L}\p{N}_-])(?:not|never)|n['\u2019]t)\s+(?:(?:necessarily|yet)\s+)?(?:(?:hold|holds|apply|applies|cover|covers|speak|speaks|extend|extends|stand|stands|list|lists|show|shows|include|includes|describe|describes)\s+(?:(?:for|to|over|about|across|of)\s+)?)?(?:all|every|each)(?:\s+one)?(?:\s+of)?(?:\s+(?:the|these|those|its|their))?(?:\s+[\p{L}\p{N}_-]+['\u2019]s)?(?:\s+(?!(?:as|because|since|while|though|whereas|yet|then|and|or|but|so|all|every|each|is|are|was|were|of)(?![\p{L}]))[\p{L}_-]+){0,2}?\s*$/iu;

/**
 * A sentence that says all, each or every of a type, or the elements of a type on screen, cites every element of that type that it speaks of, like a count: it speaks of a set, and a part of the set does not back it. Every quantified group
 * of the sentence is checked, nested ones and groups joined by a conjunction too. The set is the elements the cited reads listed, for a sentence that describes a read, the elements of the view for one that says on screen, and every element
 * sent otherwise.
 */
function universalHolds(sentence: SummarySentence, assembled: CheckedText): boolean {
  const types = assembled.elementTypes;
  if (types === undefined) return true;
  const text = flatten(withoutQuoted(sentence.text));
  const cited = new Set(citedElements(sentence, assembled));
  const reads = sentence.cites.filter((cite) => assembled.readKeys?.has(cite) === true && assembled.readElements?.has(cite) === true);
  const spoken: string[] = [];
  const forms: { readonly word: string; readonly of: (type: string) => boolean }[] = [
    ...typesSent(assembled).map(({ type, word }) => ({ word, of: (held: string) => held === type })),
    ...KIND_FORMS.map(([kind]) => ({ word: kind, of: (held: string) => kind === 'element' || (kind === 'relationship') === held.startsWith('relationship ') })),
  ];
  for (const { word, of } of forms) {
    for (const found of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_-])${termPattern(word)}(?![\\p{L}\\p{N}_-])`, 'giu'))) {
      const before = text.slice(0, found.index);
      const after = text.slice(found.index + found[0].length);
      const subject = SUBJECT_BEFORE.test(before);
      const onScreen = DEFINITE_BEFORE.test(before) && PLACE_AFTER.test(after);
      const inRead = !onScreen && READ_DESCRIPTION.test(clauseAt(text, found.index));
      // a denial that something holds for all is a limit it states, and claims nothing of the whole set
      if (DENIED_ALL.test(before)) continue;
      // `the only shared widget` is a claim of what is in common, which the check of comparison claims judges
      if (/(?<![\p{L}\p{N}_-])only\s+(?:shared|common)\s+$/iu.test(before)) continue;
      if (!QUANTIFIER_BEFORE.test(before) && !(ONLY_BEFORE.test(before) && ONLY_PLACE_AFTER.test(after)) && !onScreen && !(subject && FLOATING_AFTER.test(after))) continue;
      const population = [...types].filter(([key, held]) => of(held) && assembled.readKeys?.has(key) !== true && assembled.descriptionKeys?.has(key) !== true && (!inRead || reads.length === 0 || reads.some((cite) => assembled.readElements?.get(cite)?.includes(key) === true)) && (!onScreen || /^[ne]\d+$/u.test(key)));
      if (population.some(([key]) => !cited.has(key))) return false;
      if (ONLY_ONE_BEFORE.test(before) && found[0] === word && population.length > 1) return false;
      spoken.push(...population.map(([key]) => key));
    }
  }
  return spoken.every((key) => valuesStatedHold(sentence, assembled, key));
}

/**
 * A sentence that says a property has a value (`paymentFormat "Cash"`: the key as the line writes it, then the value) of all of a set says it of each element it cites: the line of each must hold that value for that key.
 * The keys are those of the elements the lines were written from, never a word of the check.
 */
function valuesStatedHold(sentence: SummarySentence, assembled: CheckedText, key: string): boolean {
  const line = assembled.lines.get(key) ?? '';
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  for (const property of assembled.propertyKeys?.get(key) ?? []) {
    // a value is stated when it is quoted, follows a colon or an equals sign, or is a bare number; any other word after the key is no value
    const stated = new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(property)}(?![\\p{L}\\p{N}_-])(?:\\s*[:=]\\s*(?:["“]([^"”]+)["”]|([\\p{L}\\p{N}_.-]*[\\p{L}\\p{N}]))|\\s+["“]([^"”]+)["”]|\\s+(-?\\d[\\d.,]*\\d|-?\\d))`, 'gu');
    for (const found of sentence.text.matchAll(stated)) {
      const value = found[1] ?? found[2] ?? found[3] ?? found[4] ?? '';
      if (value === '') continue;
      const held = [JSON.stringify(value), value].some((text) => new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(property)}: ${escape(text)}(?![\\p{L}\\p{N}_.-])`, 'u').test(line));
      if (!held) return false;
    }
  }
  return true;
}

/** What a negation covers in a clause: up to the end of it, or up to a new assertion that a conjunction brings (`without titles and contains sent links`). */
const NEGATED_SPAN = new RegExp(`(?:${NEGATION.source})[^]*?(?=(?<![\\p{L}\\p{N}_-])and\\s+(?:also\\s+)?(?:(?:it|they|(?:the|this|that)\\s+(?:read|reads|result|results))\\s+(?:also\\s+)?)?(?:lists?|contains?|holds?|shows?|returned|returns?|found|finds?|has|have|includes?|names?)(?![\\p{L}\\p{N}_-])|$)`, 'giu');
const READ_NOUN = /(?<![\p{L}\p{N}_-])(?:read|reads|result|results)(?![\p{L}\p{N}_-])/iu;
const READ_DESCRIPTION = /(?<![\p{L}\p{N}_-])(?:the|this|that)\s+(?:read|reads|result|results)(?:\s+\S+){0,2}?\s+(?:lists?|listed|returned|returns?|found|finds?|holds?|shows?|contains?)(?![\p{L}\p{N}_-])/iu;

/**
 * A sentence that describes what a read returned (it says the read lists, returned or found something) cites the line of that read, and names, in what it asserts, only what that read holds: the types of the elements the read listed, the
 * keys of their properties and their kinds. A word of a type, a property or a kind that the read does not hold is described beyond its line. A clause that says the read lacks something is a negative claim and asks for no positive evidence;
 * a kind that the read's line says it did not list is refused.
 */
function readDescribedHolds(sentence: SummarySentence, assembled: CheckedText): boolean {
  const types = assembled.elementTypes;
  const text = withoutQuoted(sentence.text);
  if (types === undefined || !READ_DESCRIPTION.test(flatten(text))) return true;
  const reads = sentence.cites.filter((cite) => assembled.readKeys?.has(cite) === true && /^s\d+$/u.test(cite));
  if (reads.length === 0) return false;
  const members = reads.flatMap((cite) => assembled.readElements?.get(cite) ?? []);
  const backing = [
    ...reads.map((cite) => assembled.lines.get(cite) ?? ''),
    ...members.flatMap((key) => [types.get(key) ?? '', ...(assembled.propertyKeys?.get(key) ?? [])]),
  ].join('\n');
  const asserted = clausesOf(text).map((clause) => clause.replace(NEGATED_SPAN, ' ')).join(' . ');
  const candidates = [...typesSent(assembled).map(({ word }) => word), ...[...(assembled.propertyKeys?.values() ?? [])].flat()];
  if (candidates.some((term) => termIn(term, asserted) && !termIn(term, backing))) return false;
  for (const [kind, forms] of KIND_FORMS) {
    if (kind === 'element' || !new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${forms.source})(?![\\p{L}\\p{N}_-])`, 'iu').test(asserted)) continue;
    const listed = members.some((key) => (types.get(key)?.startsWith('relationship ') === true) === (kind === 'relationship'));
    if (!listed || reads.some((cite) => statedOfKind(assembled.lines.get(cite) ?? '', forms, kind) === 0)) return false;
  }
  return true;
}

/** Whether the claims a sentence makes about absence, about all of a set and about what a read returned are backed by the lines it cites. */
const claimsAreBacked = (sentence: SummarySentence, assembled: CheckedText): boolean => absenceHolds(sentence, assembled) && universalHolds(sentence, assembled) && readDescribedHolds(sentence, assembled);

/** A property of an element that a ranking may rest on: its key and data class, and its value as exact text when it is shown, not masked and valid in its class (a decimal for `number`, an instant in nanoseconds for `dateTime`, the fixed-width text of the moment key for `date` and `localDateTime`). */
export interface RankedProperty {
  readonly key: string;
  readonly dataClass: string;
  readonly value?: string;
}

/** The data classes a ranking can be verified over. */
const ORDERED_CLASSES: ReadonlySet<string> = new Set(['number', 'date', 'dateTime', 'localDateTime']);
const TIME_CLASSES: ReadonlySet<string> = new Set(['date', 'dateTime', 'localDateTime']);

/** A finite decimal as canonical text (no plus sign, no leading or trailing zeros, no exponent, no negative zero), or undefined for anything else. The one reader of numbers of the ranking check, for the values it holds and the figure a sentence claims. */
export function decimalKey(input: unknown): string | undefined {
  const text = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : typeof input === 'string' ? input.trim() : '';
  const match = /^([-+]?)(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/u.exec(text);
  if (match === null) return undefined;
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = match;
  if (whole === '' && fraction === '') return undefined;
  const shift = Number(exponent);
  if (!Number.isInteger(shift) || Math.abs(shift) > 400) return undefined;
  let digits = whole + fraction;
  let point = whole.length + shift;
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  } else if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const integer = digits.slice(0, point).replace(/^0+/u, '') || '0';
  const decimals = digits.slice(point).replace(/0+$/u, '');
  const magnitude = decimals === '' ? integer : `${integer}.${decimals}`;
  return sign === '-' && magnitude !== '0' ? `-${magnitude}` : magnitude;
}

/** The order of two canonical decimals, exact: no rounding through a binary number. */
function compareDecimals(first: string, second: string): number {
  const negative = (text: string): boolean => text.startsWith('-');
  if (negative(first) !== negative(second)) return negative(first) ? -1 : 1;
  const [firstWhole = '', firstFraction = ''] = first.replace('-', '').split('.');
  const [secondWhole = '', secondFraction = ''] = second.replace('-', '').split('.');
  const length = Math.max(firstFraction.length, secondFraction.length);
  const left = firstWhole + firstFraction.padEnd(length, '0');
  const right = secondWhole + secondFraction.padEnd(length, '0');
  const order = left.length !== right.length ? left.length - right.length : left < right ? -1 : left > right ? 1 : 0;
  return negative(first) ? -Math.sign(order) : Math.sign(order);
}

const validDay = (year: number, month: number, day: number): boolean => month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(2000, month, 0)).getUTCDate() - (month === 2 && !((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) ? 1 : 0);
const validClock = (hours: number, minutes: number, seconds: number): boolean => hours <= 23 && minutes <= 59 && seconds <= 59;

/**
 * A moment of one data class as an ordered key, with the class and the calendar checked first: a calendar day (`date`: the day, no time; the key of the contract, at midnight), a `localDateTime` (a time is required; the fixed-width text of the moment key) and a zoned `dateTime`
 * (an instant in nanoseconds, as decimal text, so that two spellings of one instant are one value). Nothing for text that is not a whole, valid value of the class. It never reads the time zone or locale of the host; a test holds it equal to the contract's moment key.
 */
export function temporalKey(dataClass: string, text: string): string | undefined {
  if (dataClass === 'date') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
    return match !== null && validDay(Number(match[1]), Number(match[2]), Number(match[3])) ? `${text}T00:00:00.000000000` : undefined;
  }
  if (dataClass === 'localDateTime') {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/u.exec(text);
    if (match === null || !validDay(Number(match[1]), Number(match[2]), Number(match[3])) || !validClock(Number(match[4]), Number(match[5]), Number(match[6]))) return undefined;
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] ?? '').padEnd(9, '0')}`;
  }
  if (dataClass === 'dateTime') {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})(?:\[[^\]]*\])?$/u.exec(text);
    if (match === null || !validDay(Number(match[1]), Number(match[2]), Number(match[3])) || !validClock(Number(match[4]), Number(match[5]), Number(match[6]))) return undefined;
    const offset = match[8] ?? 'Z';
    if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) return undefined;
    const offsetSeconds = offset === 'Z' ? 0 : (offset.startsWith('-') ? -1 : 1) * (Number(offset.slice(1, 3)) * 3600 + Number(offset.slice(4, 6)) * 60);
    const day = new Date(0);
    day.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    day.setUTCHours(Number(match[4]), Number(match[5]), Number(match[6]), 0);
    return String((BigInt(day.getTime()) - BigInt(offsetSeconds) * 1000n) * 1_000_000n + BigInt((match[7] ?? '').padEnd(9, '0')));
  }
  return undefined;
}

const compareValues = (dataClass: string, first: string, second: string): number => (dataClass === 'number' ? compareDecimals(first, second) : dataClass === 'dateTime' ? (BigInt(first) < BigInt(second) ? -1 : BigInt(first) > BigInt(second) ? 1 : 0) : first < second ? -1 : first > second ? 1 : 0);

const WB = '(?<![\\p{L}\\p{N}_-])';
const WE = '(?![\\p{L}\\p{N}_-])';
/** The end of a ranking word: a hyphen and more letters (`highest-value`) are still the word. */
const RWE = '(?![\\p{L}\\p{N}_])';
/** The words of a ranking, with their direction: language, never a word of a domain. `most` counts only after the words that make it a measure (`the most`, `has most`), never as a quantifier; `at least` and `at most` are neither. */
const RANKING_WORDS: readonly (readonly [RegExp, 'max' | 'min'])[] = [
  [new RegExp(`${WB}(?:largest|biggest|greatest|highest|maximum|latest)${RWE}`, 'giu'), 'max'],
  [new RegExp(`${WB}(?:smallest|lowest|minimum|earliest|fewest)${RWE}`, 'giu'), 'min'],
  [new RegExp(`${WB}(?<!at\\s+)least${RWE}`, 'giu'), 'min'],
  [new RegExp(`${WB}(?:the|has|have|had|holds?|with)\\s+(most)${RWE}(?!\\s+of${RWE})`, 'giu'), 'max'],
];
const MORE_THAN_READ = /(?<![\p{L}\p{N}_-])(?:in total|overall|anywhere|source-wide|not yet retrieved|(?:in|across|of|from) (?:the )?(?:entire |whole |full |complete )?(?:source|database|dataset|data|graph)|(?:entire|whole|full|complete) (?:source|database|dataset|data|graph))(?![\p{L}\p{N}_-])/iu;
const UNAVAILABLE = /(?<![\p{L}\p{N}_-])(?:do not show|does not show|is not shown|are not shown|cannot say|do not hold)(?![\p{L}\p{N}_-])/iu;

/** The words of a key or of a sentence: at capital letters, digits and anything that is no letter. */
const subwordsOf = (text: string): string[] => (text.match(/\p{Lu}?\p{Ll}+|\p{Lu}+(?!\p{Ll})|\p{N}+/gu) ?? []).map((word) => word.toLowerCase());

/** `top` and `tops` as words of a ranking, the greatest: `top-ranked` and `top-rated` are one word. */
const TOP = new RegExp(`${WB}(?:top-ranked|top-rated|tops?)${RWE}`, 'giu');
/** The places of a screen that `top` may speak of: words of the product and of the language. */
const SCREEN_PLACE = '(?:view|screen|page|list|panel|table|row|bar|corner|edge|graph|timeline|card)s?';
/** `top` that names a position on the screen, a level or a topping up, and ranks nothing. */
const ORDINARY_TOP = new RegExp(`^top(?:[\\s-](?:level|left|right|up|down)${WE}|\\s+(?:(?:left|right)[\\s-])?${SCREEN_PLACE}${WE})|^tops[\\s-]up${WE}`, 'iu');
const ON = new RegExp(`${WB}on\\s+$`, 'iu');
const AT_THE_TOP = new RegExp(`${WB}(?:at|from)\\s+the\\s+$`, 'iu');
const OF_A_PLACE = new RegExp(`^top[\\s-](?:(?:left|right)\\s+)?(?:of\\s+(?:the\\s+|this\\s+)?${SCREEN_PLACE}${WE}|(?:left|right)${WE})`, 'iu');

/** Whether the `top` at a position is one of the ordinary uses of the word. At the top of a place is one only where nothing in its clause says by what. */
function ordinaryTop(text: string, at: number): boolean {
  // the words just before and after are all that decide: a long text is not read again for each use
  const before = text.slice(Math.max(0, at - 40), at);
  const from = text.slice(at, at + 200);
  // `on top of` is a position or an addition; `on top` with nothing after it of that kind ranks
  if (ON.test(before) && /^top\s+of(?![\p{L}\p{N}_])/iu.test(from)) return true;
  if (/^top\s+to\s+bottom/iu.test(from)) return true;
  const place = AT_THE_TOP.test(before) ? OF_A_PLACE.exec(from) : null;
  if (place !== null) {
    // by what is said in the words that follow the place, in its clause: `by`, `for` or `in` something, or a figure right after it
    const rest = /^(?:[^.,;:!?]|[.,](?=\d))*?(?=$|[.,;:!?](?!\d)|(?<![\p{L}\p{N}_-])(?:and|but|while|where)(?![\p{L}\p{N}_-]))/u.exec(from.slice(place[0].length))?.[0] ?? '';
    return !/(?<![\p{L}\p{N}_-])(?:by|for|in)(?![\p{L}\p{N}_-])|^\s*(?:(?:with|at)\s+)?[-+]?\d/iu.test(rest);
  }
  return ORDINARY_TOP.test(from);
}

/** The uses of `top` that rank, outside quoted text: a title in quotes is a name. */
function rankingTopsIn(text: string): { readonly direction: 'max'; readonly index: number; readonly end: number; readonly word: string }[] {
  const unquoted = text.replace(QUOTED, (quoted) => ' '.repeat(quoted.length));
  return [...unquoted.matchAll(TOP)].filter((found) => !ordinaryTop(unquoted, found.index)).map((found) => ({ direction: 'max' as const, index: found.index, end: found.index + found[0].length, word: 'top' }));
}

/** A ranking written with `top` that names more than one element, or says an element is only near the top: nothing the cited values can show. */
const NOT_ONE_AT_THE_TOP = (text: string, claim: { readonly index: number; readonly end: number }): boolean =>
  new RegExp(`^\\s+(?:\\d+|${CARDINAL_WORDS}|few|several)(?![\\p{L}\\p{N}_])`, 'iu').test(text.slice(claim.end)) || /(?<![\p{L}\p{N}_-])(?:one\s+of|among|in)\s+(?:the\s+)?$/iu.test(text.slice(0, claim.index));

/** The ranking words of a text, with where each one ends. */
const rankingWordsIn = (text: string): { readonly direction: 'max' | 'min'; readonly index: number; readonly end: number; readonly word: string }[] =>
  [...RANKING_WORDS.flatMap(([pattern, direction]) => [...text.matchAll(pattern)].map((found) => ({ direction, index: found.index, end: found.index + found[0].length, word: (found[1] ?? found[0]).toLowerCase() }))), ...rankingTopsIn(text)].sort((first, second) => first.index - second.index);

/**
 * The words that say how large a gap is, which no cited value shows: one list of generic English. `far more` and the like claim a gap only before `than`, since `much more is not yet retrieved` compares nothing.
 */
const GAP_DEGREE = '(?:far|much|way|vastly|significantly|substantially|considerably)';
const GAP_WORDS = new RegExp(
  `${WB}(?:by\\s+far|far\\s+and\\s+away|by\\s+a\\s+(?:wide|large|big|huge)\\s+margin|by\\s+some\\s+distance|by\\s+a\\s+long\\s+way|${GAP_DEGREE}[\\s-]+(?:larger|higher|greater|bigger|smaller|lower|later|earlier)|(?:${GAP_DEGREE}|a\\s+lot)\\s+(?:more|less|fewer)(?=[^.,;:!?]*?${WB}than${WE})|(?:far|well|way)\\s+(?:ahead|above|exceeds|exceeded)|dwarf(?:s|ed|ing)?|towers?\\s+over)${WE}`,
  'iu',
);

/** A sentence that says how far apart two things are is not verified: the cited values show an order, and no rule says what a large gap is. */
function gapClaimsHold(sentence: SummarySentence, assembled: CheckedText): boolean {
  let text = sentence.text.normalize('NFC');
  // a name is blanked only where it is written as it is: an id of one letter is not the article
  for (const name of namesOfElements(assembled)) text = text.replace(new RegExp(`${WB}${ESCAPED(name)}${WE}`, 'gu'), (found) => ' '.repeat(found.length));
  return !GAP_WORDS.test(withoutQuoted(text).replace(/\u201c[^\u201d]*\u201d/gu, ' '));
}

/** The words that follow a position, each with where it ends: letters and digits, joined only by white space, hyphens and underscores, so that a mark of punctuation ends them. */
function wordsAfter(text: string, from: number): { readonly raw: string; readonly end: number }[] {
  const out: { raw: string; end: number }[] = [];
  let at = from;
  for (;;) {
    const found = /^[\s_-]*([\p{L}\p{N}]+)/u.exec(text.slice(at));
    if (found === null || (out.length === 0 && !/^\s/u.test(text.slice(at)))) break;
    at += found[0].length;
    out.push({ raw: found[1] ?? '', end: at });
  }
  return out;
}

/** The property a ranking word names: the key whose words follow it whole and in order, an exact raw key before any other match, and a prefix of a key's words only when no other key starts with them. Undefined when none or more than one. */
function propertyAfter(text: string, from: number, keys: readonly string[]): { readonly key: string; readonly end: number } | undefined {
  const following = wordsAfter(text, from);
  const first = following[0];
  if (first === undefined) return undefined;
  const exact = keys.find((key) => key === first.raw);
  if (exact !== undefined) return { key: exact, end: first.end };
  const pieces = following.flatMap((word, index) => subwordsOf(word.raw).map((sub) => ({ sub, token: index })));
  const matched = keys.map((key) => {
    const own = subwordsOf(key);
    let length = 0;
    while (length < own.length && length < pieces.length && own[length] === pieces[length]?.sub) length += 1;
    return { key, length, whole: length === own.length && own.length > 0 };
  }).filter((entry) => entry.length > 0);
  const wholes = matched.filter((entry) => entry.whole);
  const best = wholes.length > 0 ? wholes : matched;
  const longest = Math.max(...best.map((entry) => entry.length), 0);
  const chosen = best.filter((entry) => entry.length === longest);
  const only = chosen[0];
  if (only === undefined || chosen.length !== 1) return undefined;
  const lastToken = pieces[only.length - 1]?.token ?? 0;
  return { key: only.key, end: following[lastToken]?.end ?? first.end };
}

/** The property a sentence names before its ranking word (`has amountValue 12, the largest of them`): the one key of the cited elements that is written there whole, nothing when none or several are. */
function propertyBefore(text: string, until: number, keys: readonly string[]): { readonly key: string; readonly end: number } | undefined {
  const before = text.slice(0, until);
  const written = keys.flatMap((key) => {
    const pieces = subwordsOf(key);
    if (pieces.length === 0) return [];
    const ends = [...before.matchAll(new RegExp(`${WB}${pieces.map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]*')}${WE}`, 'giu'))].map((found) => found.index + found[0].length);
    const end = ends[ends.length - 1];
    return end === undefined ? [] : [{ key, end }];
  });
  const [only] = written;
  return written.length === 1 ? only : undefined;
}

const NUMBER_LITERAL = /[-+]?(?:\d(?:[\d,]*\d)?(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?/u;
const TEMPORAL_LITERAL: Readonly<Record<string, RegExp>> = {
  dateTime: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})(?:\[[^\]]*\])?/u,
  localDateTime: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?![\d.:]|Z|[+-]\d)/u,
  date: /\d{4}-\d{2}-\d{2}(?![\dT])/u,
};

/** The figure a sentence claims for the ranked property: the first literal of the class that follows the words of the property in the same clause, read whole. `invalid` for a literal that is no valid value of the class, or a time written in another shape than the class's. */
function claimedValueOf(text: string, from: number, dataClass: string): { readonly value?: string; readonly invalid?: true } {
  const clause = text.slice(from).split(/[.;!?](?:\s|$)/u)[0] ?? '';
  const pattern = dataClass === 'number' ? NUMBER_LITERAL : TEMPORAL_LITERAL[dataClass];
  const found = pattern === undefined ? null : pattern.exec(clause);
  if (dataClass !== 'number') {
    const any = /\d{4}-\d{2}-\d{2}[T\d:.Z+-]*(?:\[[^\]]*\])?/u.exec(clause);
    if (any !== null && (found === null || found.index !== any.index || found[0] !== any[0])) return { invalid: true };
  }
  if (found === null) return {};
  const literal = found[0];
  const value = dataClass === 'number' ? decimalKey(/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(literal.replace(/^[-+]/u, '')) ? literal.replaceAll(',', '') : literal) : temporalKey(dataClass, literal);
  return value === undefined ? { invalid: true } : { value };
}

const NOT_ABLE = '(?:cannot|can\\s+not|can[\'\u2019]t|could\\s+not|couldn[\'\u2019]t)';
const LINKING_WORD = '(?:and|but|so|which|while|or|yet|because)(?![\\p{L}])';
/** `<ranking word> … cannot be named`: words alone between them, none that opens another assertion, and no `to be …` after, which would say something of what is ranked. */
const REFUSED_AFTER = new RegExp(`^(?:\\s+(?!${LINKING_WORD}|${NOT_ABLE})[\\p{L}\'\u2019_-]+){0,5}?\\s+${NOT_ABLE}\\s+be\\s+(?:named|identified|determined|told|ranked|said|established|stated|chosen|picked(?:\\s+out)?)${WE}(?!\\s+to${WE})`, 'iu');
/** `cannot identify the <ranking word>`. */
const REFUSED_BEFORE = new RegExp(`${WB}${NOT_ABLE}\\s+(?:name|identify|determine|tell|rank|establish|state|choose|pick\\s+out)\\s+(?:(?:which\\s+is\\s+)?(?:the|a)\\s+)?$`, 'iu');

/** Words after a refusal that go on to say who holds the ranking after all. */
const GOES_ON_TO_HOLD = /(?<![\p{L}\p{N}_-])(?:which\s+is|it\s+is|except|other\s+than|apart\s+from|besides)(?![\p{L}\p{N}_-])/iu;

/**
 * Whether a sentence says that the ranking a word stands for cannot be made, and goes on to name no holder: it ranks nothing. In the rest of the sentence, for either form of the refusal, a holder is the name of an element
 * that has a value that could be ranked, a figure that is such a value of a cited element or is not written on a cited line of a read, or words that lead to a holder (`it is`, `except`, `other than`).
 */
function refusesToRank(sentence: SummarySentence, assembled: CheckedText, text: string, claim: { readonly index: number; readonly end: number }): boolean {
  const written = sentence.text.normalize('NFC');
  const rankable = [...(assembled.rankedValues ?? [])].filter(([, properties]) => properties.some((property) => ORDERED_CLASSES.has(property.dataClass)));
  const names = rankable.flatMap(([key]) => namesOfKey(key, assembled)).filter((name) => name !== '');
  const holdsNothing = (from: number): boolean => {
    const stop = /[.!?](?!\d)/u.exec(text.slice(from));
    const until = stop === null ? text.length : from + stop.index;
    const rest = written.slice(from, until);
    if (GOES_ON_TO_HOLD.test(text.slice(from, until)) || names.some((name) => occursWhole(name, rest))) return false;
    const read = new Set(sentence.cites.filter((cite) => assembled.readKeys?.has(cite) === true).flatMap((cite) => numbersIn(assembled.lines.get(cite) ?? '')));
    const values = new Set(sentence.cites.flatMap((cite) => (assembled.rankedValues?.get(cite) ?? []).flatMap((property) => (property.value === undefined ? [] : [property.value]))));
    return numbersIn(text.slice(from, until)).every((figure) => read.has(figure) && !values.has(figure));
  };
  if (REFUSED_BEFORE.test(text.slice(Math.max(0, claim.index - 60), claim.index))) return holdsNothing(claim.end);
  const found = REFUSED_AFTER.exec(text.slice(claim.end, claim.end + 200));
  if (found === null) return false;
  const after = claim.end + found[0].length;
  // a name between the ranking word and the refusal (blanked in the text read) is a holder the sentence speaks of
  return written.slice(claim.end, after) === text.slice(claim.end, after) && holdsNothing(after);
}

/**
 * A sentence that ranks (says the largest, smallest, latest, earliest, fewest, most or least) is verified against the values it rests on, or removed. It must name one property of the cited elements whose words follow the ranking word, in a data class
 * that can be ordered (a number, a date or an instant, compared exactly), and every element of the ranked type that was sent must be cited with a shown value of it: the element it names, or the figure it claims, must be the one extreme value, held by
 * exactly one element. A negated or conflicting ranking, a ranking of something that is no property (a count of related elements, a sum), a ranking over more than was read, a masked or missing value, an uncited element and a tie are not verified.
 * An honest statement that the elements do not show an answer is judged as before. The names of the elements and the keys of the properties are the mapping's: nothing here is a word of a domain.
 */
function rankingHolds(sentence: SummarySentence, assembled: CheckedText): boolean {
  const names = namesOfElements(assembled);
  // what names an element is no ranking word and no property: the names are taken out, and what is quoted otherwise stays, since a claimed value may be quoted
  let text = sentence.text.normalize('NFC');
  for (const name of names) text = text.replace(new RegExp(`${WB}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${WE}`, 'giu'), (found) => ' '.repeat(found.length));
  const all = rankingWordsIn(text);
  if (all.length === 0) return true;
  // one ranking is verified at most: a sentence with dozens of ranking words is not read word by word against its rest
  if (all.length > 40) return false;
  const cited = citedElements(sentence, assembled);
  const carries = (key: string): readonly RankedProperty[] => assembled.rankedValues?.get(key) ?? [];
  const shownKeys = [...new Set(cited.flatMap((key) => carries(key).filter((entry) => entry.value !== undefined).map((entry) => entry.key)))];
  // a clause that says the elements do not show an answer, and ranks no property that the cited elements show a value of, is an honest statement judged as before
  const exempt = (claim: { readonly index: number; readonly end: number }): boolean => UNAVAILABLE.test(clauseAt(text, claim.index)) && propertyAfter(text, claim.end, shownKeys) === undefined;
  // a ranking word that begins a property key the cited elements carry, and is followed by the rest of its words, names the property and ranks nothing (`latest status`); `a maximum of` is a quantity, not an assertion
  const everyKey = [...new Set(cited.flatMap((key) => carries(key).map((entry) => entry.key)))];
  const namesProperty = (claim: { readonly end: number; readonly word: string; readonly index: number }): boolean => {
    const following = wordsAfter(text, claim.end).flatMap((word) => subwordsOf(word.raw));
    const words = [claim.word, ...following];
    const asKey = everyKey.some((key) => {
      const own = subwordsOf(key);
      return own.length >= 2 && own[0] === claim.word && own.every((part, position) => words[position] === part);
    });
    return asKey || /(?:^|\s)an?\s+$/iu.test(text.slice(0, claim.index));
  };
  const claims = all.filter((claim) => !namesProperty(claim) && !exempt(claim) && !refusesToRank(sentence, assembled, text, claim));
  if (claims.length === 0) return true;
  // one ranking claim in a sentence: a compound ranking is written as separate sentences
  const [claim] = claims;
  if (claim === undefined || claims.length > 1 || assembled.rankedValues === undefined) return false;
  const clauseStart = Math.max(text.lastIndexOf(',', claim.index), text.lastIndexOf(';', claim.index), text.lastIndexOf('.', claim.index), text.lastIndexOf(' but ', claim.index), -1) + 1;
  if (NEGATION.test(text.slice(clauseStart, claim.index))) return false;
  if (claim.word === 'top' && NOT_ONE_AT_THE_TOP(text, claim)) return false;
  if (MORE_THAN_READ.test(text)) return false;
  const carriers = cited.filter((key) => carries(key).length > 0);
  const keys = [...new Set(carriers.flatMap((key) => carries(key).map((property) => property.key)))];
  // `on top with <property>`, `ranks top by <property>`: for `top` the property may follow the word that says by what
  const link = claim.word === 'top' ? (/^\s+(?:with|by|for)(?:\s+(?:an?|the))?(?=\s)/iu.exec(text.slice(claim.end))?.[0].length ?? 0) : 0;
  const property = propertyAfter(text, claim.end + link, keys) ?? propertyBefore(text, claim.index, keys);
  if (property === undefined) return false;
  const typeOf = (key: string): string | undefined => assembled.elementTypes?.get(key);
  const holders = carriers.filter((key) => carries(key).some((entry) => entry.key === property.key));
  const listed = enumeratedScope(sentence, assembled);
  const sentence_ = listed?.outside ?? sentence.text.normalize('NFC');
  const named = (key: string): boolean => namesOfKey(key, assembled).some((name) => name !== '' && occursWhole(name, sentence_));
  let types = [...new Set(holders.map((key) => typeOf(key)).filter((type): type is string => type !== undefined))];
  if (listed !== undefined && listed.keys.every((key) => holders.includes(key))) types = [listed.type];
  else if (types.length > 1) types = [...new Set(holders.filter(named).map((key) => typeOf(key)).filter((type): type is string => type !== undefined))];
  const [rankedType] = types;
  if (rankedType === undefined || types.length !== 1) return false;
  const candidates = holders.filter((key) => typeOf(key) === rankedType && named(key));
  if (candidates.length > 1) return false;
  const lines = new Set([...(assembled.readKeys ?? []), ...(assembled.descriptionKeys ?? [])]);
  const scope = scopeOf(sentence, assembled, rankedType);
  const population = scope?.keys ?? [...(assembled.elementTypes ?? [])].filter(([key, type]) => type === rankedType && !lines.has(key)).map(([key]) => key);
  const values = new Map<string, { readonly dataClass: string; readonly value: string }>();
  for (const key of population) {
    const entry = carries(key).find((candidate) => candidate.key === property.key);
    if (!cited.includes(key) || entry === undefined || entry.value === undefined || !ORDERED_CLASSES.has(entry.dataClass)) return false;
    values.set(key, { dataClass: entry.dataClass, value: entry.value });
  }
  const classes = new Set([...values.values()].map((held) => held.dataClass));
  const [dataClass] = classes;
  if (dataClass === undefined || classes.size !== 1) return false;
  if ((claim.word === 'latest' || claim.word === 'earliest') && !TIME_CLASSES.has(dataClass)) return false;
  const sign = claim.direction === 'max' ? 1 : -1;
  const ordered = [...values].sort(([, first], [, second]) => sign * compareValues(dataClass, second.value, first.value));
  const [top, next] = ordered;
  if (top === undefined || (next !== undefined && compareValues(dataClass, top[1].value, next[1].value) === 0)) return false;
  const claimed = claimedValueOf(text, property.end, dataClass);
  if (claimed.invalid === true) return false;
  const [only] = candidates;
  if (only === undefined && claimed.value === undefined) return false;
  if (only !== undefined && only !== top[0]) return false;
  return claimed.value === undefined || compareValues(dataClass, claimed.value, top[1].value) === 0;
}

const RANGE_LITERAL = '(?:\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})?|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:Z|[+-]\\d{2}:\\d{2})?|[-+]?\\d[\\d,]*(?:\\.\\d+)?)';
const RANGE = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:between|from)\\s+["“]?(${RANGE_LITERAL})["”]?\\s+(?:and|to)\\s+["“]?(${RANGE_LITERAL})["”]?(?![\\p{L}\\p{N}_-])`, 'iu');

/** The instant of a class that a line holds as the value whose key is `value`: the text the line writes for it. */
const instantOfLine = (line: string, dataClass: string, value: string): string | undefined =>
  [...line.matchAll(dataClass === 'date' ? /\d{4}-\d{2}-\d{2}(?![\dT])/gu : INSTANT_IN_TEXT)].map((found) => found[0]).find((instant) => temporalKey(dataClass, instant) === value);

/**
 * A sentence that gives the range of a property over a set (`between A and B`, `from A to B`) is verified like a ranking: it names one orderable property of the cited elements, every element of the ranked type that was sent is cited with a
 * shown value of it, A is the least value among them and B the greatest. A figure is the value as the line writes it; a date or a time of an instant is an exact part of the instant the line holds for the least or the greatest, never a rounding; a
 * date the sentence gives besides (`on 2022-09-09`) is the date of every one of them. A partly cited set, a mixed class, a wrong end and a masked or missing value are not verified.
 */
function rangeHolds(sentence: SummarySentence, assembled: CheckedText): boolean {
  const text = sentence.text.normalize('NFC');
  const range = RANGE.exec(text);
  if (range === null) return true;
  const [whole = '', first = '', second = ''] = range;
  const cited = citedElements(sentence, assembled);
  const carries = (key: string): readonly RankedProperty[] => assembled.rankedValues?.get(key) ?? [];
  if (assembled.rankedValues === undefined) return false;
  const typeOf = (key: string): string | undefined => assembled.elementTypes?.get(key);
  const outside = text.replace(whole, ' ');
  // every pair of a type and an orderable property that the cited elements hold is a candidate for what the range is over
  const pairs = [...new Map(cited.flatMap((key) => {
    const type = typeOf(key);
    return type === undefined ? [] : carries(key).filter((entry) => ORDERED_CLASSES.has(entry.dataClass)).map((entry) => [`${type}\u0000${entry.key}\u0000${entry.dataClass}`, { type, property: entry.key, dataClass: entry.dataClass }] as const);
  }))].map(([, pair]) => pair);
  const temporal = (literal: string): boolean => /^\d{4}-\d{2}-\d{2}|^\d{1,2}:\d{2}/u.test(literal);
  // the ends are both dates or times, or both figures; a pair of another kind is no range over a set
  if (temporal(first) !== temporal(second)) return true;
  const ofTime = temporal(first);
  // an end that is a time of day or an instant is of a property that holds a time, not of one that holds a day alone
  const ofATime = !/^\d{4}-\d{2}-\d{2}$/u.test(first) || !/^\d{4}-\d{2}-\d{2}$/u.test(second);
  const fitting = pairs.filter((pair) => (ofTime ? TIME_CLASSES.has(pair.dataClass) && (!ofATime || pair.dataClass !== 'date') : pair.dataClass === 'number'));
  // a property of another class that the sentence happens to name is no property of this range
  const keyNamed = [...new Set(fitting.map((pair) => pair.property))].filter((key) => termIn(key, outside));
  if (keyNamed.length > 1) return false;
  const wordOf = new Map(typesSent(assembled).map(({ type, word }) => [type, word]));
  const flat = flatten(outside);
  const plural = (word: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}_-])${word.endsWith('y') ? `${escapeRegex(word.slice(0, -1))}ies` : `${escapeRegex(word)}(?:s|es)`}(?![\\p{L}\\p{N}_-])`, 'iu').test(flat);
  // figures that name no property: a range over the figures of a set only when the sentence names a cited type by its plural noun, as for dates and times; a singular subject (`Account A-1 was active from 2019 to 2021`) is judged as before
  const needsPlural = keyNamed.length === 0 && !ofTime;
  const named = (type: string): boolean => {
    const word = wordOf.get(type);
    return word !== undefined && (needsPlural ? plural(flatten(word).trim()) : termIn(word, outside));
  };
  if (needsPlural && !fitting.some((pair) => named(pair.type))) return true;
  let candidates = fitting.filter((pair) => keyNamed.length === 0 || pair.property === keyNamed[0]);
  // a sentence that names a type with its noun is about that type alone: an element of another type cited beside it is context
  const namedTypes = new Set(candidates.filter((pair) => named(pair.type)).map((pair) => pair.type));
  // more than one type named: not verified, whichever of them would hold
  if (namedTypes.size > 1) return false;
  if (namedTypes.size > 0) candidates = candidates.filter((pair) => namedTypes.has(pair.type));
  if (candidates.length === 0) return keyNamed.length === 0;
  /** Whether the range holds over one property of one type: the whole set of its type is cited with values, A is the least, B the greatest, and a time of day or a date beside it is the one of every element. */
  const verifies = (rankedType: string, property: string): boolean => {
    const lines = new Set([...(assembled.readKeys ?? []), ...(assembled.descriptionKeys ?? [])]);
    const members = [...(assembled.elementTypes ?? [])].filter(([key, type]) => type === rankedType && !lines.has(key)).map(([key]) => key);
    const values = new Map<string, { readonly dataClass: string; readonly value: string }>();
    for (const key of members) {
      const entry = carries(key).find((candidate) => candidate.key === property);
      if (!cited.includes(key) || entry === undefined || entry.value === undefined || !ORDERED_CLASSES.has(entry.dataClass)) return false;
      values.set(key, { dataClass: entry.dataClass, value: entry.value });
    }
    const classes = new Set([...values.values()].map((held) => held.dataClass));
    const [dataClass] = classes;
    if (dataClass === undefined || classes.size !== 1) return false;
    const ordered = [...values].sort(([, left], [, right]) => compareValues(dataClass, left.value, right.value));
    const least = ordered[0];
    const greatest = ordered[ordered.length - 1];
    if (least === undefined || greatest === undefined) return false;
    const holders = (end: readonly [string, { readonly value: string }]): string[] => ordered.filter(([, held]) => compareValues(dataClass, held.value, end[1].value) === 0).map(([key]) => key);
    const endHolds = (literal: string, end: readonly [string, { readonly dataClass: string; readonly value: string }]): boolean => {
      if (dataClass === 'number') return decimalKey(/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(literal.replace(/^[-+]/u, '')) ? literal.replaceAll(',', '') : literal) === end[1].value;
      return holders(end).some((key) => {
        const instant = instantOfLine(assembled.lines.get(key) ?? '', dataClass, end[1].value);
        return instant !== undefined && (dataClass === 'date' ? literal === instant : partsOfInstant(instant).includes(literal));
      });
    };
    if (!endHolds(first, least) || !endHolds(second, greatest)) return false;
    // an end that is a time of day says that every instant of the set lies in that window of one day: the set shares one date
    if (dataClass !== 'number' && (!/^\d{4}-/u.test(first) || !/^\d{4}-/u.test(second))) {
      const dates = new Set(members.map((key) => instantOfLine(assembled.lines.get(key) ?? '', dataClass, values.get(key)?.value ?? '')?.slice(0, 10)));
      if (dates.size !== 1 || dates.has(undefined)) return false;
    }
    // a date the sentence gives besides the range is the date of every element of the set
    if (dataClass !== 'number') {
      for (const other of text.replace(whole, ' ').matchAll(TEMPORAL_LITERAL_IN_TEXT)) {
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(other[0])) continue;
        if (!members.every((key) => instantOfLine(assembled.lines.get(key) ?? '', dataClass, values.get(key)?.value ?? '')?.startsWith(other[0]) === true)) return false;
      }
    }
    return true;
  };
  // no type is named and more than one could be what the range is over: it holds only when every one of them with its whole set cited has a property that verifies it; a type cited in part is context
  const candidateTypes = new Set(candidates.map((pair) => pair.type));
  if (candidateTypes.size > 1) {
    const lines = new Set([...(assembled.readKeys ?? []), ...(assembled.descriptionKeys ?? [])]);
    const wholeSet = (type: string): boolean => [...(assembled.elementTypes ?? [])].every(([key, held]) => held !== type || lines.has(key) || cited.includes(key));
    const fullyCited = [...candidateTypes].filter(wholeSet);
    return fullyCited.length > 0 && fullyCited.every((type) => candidates.some((pair) => pair.type === type && verifies(pair.type, pair.property)));
  }
  return candidates.some((pair) => verifies(pair.type, pair.property));
}

/** How many claim words of one sentence are read, and how many clauses back a claim looks for what it is about: a sentence beyond either is not written to be read, and the check would take time that grows far faster than its length. */
const MOST_CLAIMS = 20;
const MOST_CLAUSES_BACK = 20;
/** The longest list after `differ in` that is read, in characters. */
const LONGEST_LIST = 600;
const MOST_LISTED = 20;

/** The words that say elements differ, are the same or share something: words of the language, never of a domain. A word joined to another before it (`co-shared`) is no claim. */
const CLAIM_WORD = /(?<![\p{L}\p{N}_-])(differ(?:s|ed|ing|ently|ences?|ent)?|distinct|var(?:y|ies|ied|ying)|same|identical|alike|shar(?:e|es|ed|ing)|in common|common to)(?![\p{L}\p{N}_])/giu;

type ClaimKind = 'differ' | 'same' | 'share';

const kindOfClaim = (word: string): ClaimKind => (/^(?:differ|distinct|var)/u.test(word) ? 'differ' : /^(?:same|identical|alike)/u.test(word) ? 'same' : 'share');

/** Where a clause ends: a mark of punctuation that is not inside a number, or a word that turns the sentence. */
const CLAUSE_BREAK = /[;!?]|[.,:](?!\d)|(?<![\p{L}\p{N}_-])(?:but|although|and yet)(?![\p{L}\p{N}_-])/giu;

interface Span {
  readonly start: number;
  readonly end: number;
}

function clauseSpanAt(text: string, at: number): Span {
  let start = 0;
  for (const found of text.matchAll(CLAUSE_BREAK)) {
    // a position inside the break itself belongs to the clause it ends, so that stepping back from a clause always moves back
    if (found.index + found[0].length > at) return { start, end: found.index };
    start = found.index + found[0].length;
  }
  return { start, end: text.length };
}

const PHRASE_WORD = /[\p{L}\p{N}_]+/gu;

const KNOWING = '(?:show|shows|shown|say|tell|know|known|see|seen|establish|established|answer|answered|identify|identified|state|stated|read|retrieve|retrieved)';
const CANNOT_TELL = new RegExp(`(?:(?<![\\p{L}\\p{N}_-])(?:cannot|can not|could not|does not|do not|did not|not|never)|n['\\u2019]t)\\s+(?:(?:yet|be|been|fully)\\s+)*${KNOWING}(?![\\p{L}\\p{N}_-])`, 'giu');
/** `no … is shown`: a span that a negation opens and a verb of knowing ends, within one clause. */
const NONE_TOLD = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:no|nothing|none)(?![\\p{L}\\p{N}_-])[^.;]{0,160}?(?<![\\p{L}\\p{N}_-])(?:is|are|was|were|can be|could be)\\s+(?:(?:yet|fully)\\s+)?${KNOWING}(?![\\p{L}\\p{N}_-])`, 'giu');
/** A word that opens another assertion: what stands across it from a negated verb is not what the verb denies. */
const ANOTHER_ASSERTION = /(?<![\p{L}\p{N}_-])(?:and|so|which|while|whereas|yet)(?![\p{L}\p{N}_-])/iu;

/** The words that may stand before a claim word inside the subject of a verb (`so a shared … cannot be seen`). */
const SUBJECT_LEAD: ReadonlySet<string> = new Set(['so', 'and', 'but', 'thus', 'therefore', 'hence', 'a', 'an', 'the', 'any', 'such', 'these', 'those', 'their', 'its', 'whether', 'also', 'then']);

/**
 * Whether the claim word of a clause stands where the clause only says that it cannot be told, or is not shown: after `whether` or `if`, on either side of a negated verb of showing or knowing with no other assertion between,
 * or inside a `no … is shown`. Such words claim nothing of the elements and are judged as before.
 */
function saysItCannotBeTold(clause: string, claimAt: number, written: string): boolean {
  if (/(?<![\p{L}\p{N}_-])(?:whether|if)(?![\p{L}\p{N}_-])/iu.test(clause.slice(0, claimAt))) return true;
  const joined = (from: number, to: number): boolean => from <= to && !ANOTHER_ASSERTION.test(clause.slice(from, to));
  // a verb after the claim word denies it only where the word is in the verb's subject: nothing but linking words before it, and no relative word between them
  // read as written: a name before the claim word, blanked elsewhere, is the subject of an assertion
  const inSubject = (verbAt: number): boolean => [...written.slice(0, claimAt).matchAll(PHRASE_WORD)].every(([word]) => SUBJECT_LEAD.has(word.toLowerCase())) && !/(?<![\p{L}\p{N}_-])(?:that|who|whom|whose|which)(?![\p{L}\p{N}_-])/iu.test(clause.slice(claimAt, verbAt));
  const denied = [...clause.matchAll(CANNOT_TELL)].some((found) => joined(found.index + found[0].length, claimAt) || (joined(claimAt, found.index) && inSubject(found.index)));
  return denied || [...clause.matchAll(NONE_TOLD)].some((found) => found.index <= claimAt && claimAt < found.index + found[0].length && joined(claimAt, found.index + found[0].length));
}

/** The fixed phrases by which a sentence says it speaks of what was read or shown. */
const LIMITED_TO_READ = /(?<![\p{L}\p{N}_-])(?:in view|in the view|on screen|shown|in the reads?|that were read|among those read|(?:in|within) (?:this|that) sample|sampled)(?![\p{L}\p{N}_-])/iu;
/** Words that point at a named few (`these three`, `among these`, `none of them`): they limit a claim only where no read listed what it rests on, since the check is not told how a read was filtered. */
const POINTED_FEW = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:(?:these|those)\\s+(?:\\d+|${CARDINAL_WORDS})|among (?:these|those)|of them|of the (?:\\d+|${CARDINAL_WORDS}) [\\p{L}]+ read)(?![\\p{L}\\p{N}_-])`, 'iu');
/** What a line writes for a count that is not exact. */
const NOT_EXACT = /\u2265|~|(?<![\p{L}\p{N}_-])(?:lower bound|estimated|not known|unknown)(?![\p{L}\p{N}_-])/iu;
/** The finding of a read that states its count as exact. */
const EXACT_FINDING = /(?<!not )(?<![\p{L}\p{N}_-])exact(?![\p{L}\p{N}_-])/iu;

/** The words that end the noun phrase a claim word governs. */
const PHRASE_STOP: ReadonlySet<string> = new Set(['for', 'among', 'amongst', 'between', 'with', 'as', 'and', 'or', 'nor', 'but', 'they', 'them', 'it', 'its', 'their', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'by', 'to', 'from', 'than', 'so', 'because', 'which', 'who', 'whose', 'when', 'while', 'where', 'in', 'on', 'at', 'across', 'within', 'of', 'do', 'does', 'did', 'not', 'each', 'all', 'both', 'every']);
/** Words of a noun phrase that name nothing by themselves. */
const FILLER: ReadonlySet<string> = new Set(['a', 'an', 'the', 'that', 'this', 'these', 'those', 'one', 'any', 'no', 'same', 'single', 'also', 'only', 'other', 'own', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'its', 'their', 'they', 'them', 'some', 'several']);

interface Word {
  readonly text: string;
  readonly index: number;
}

const wordsAt = (text: string, span: Span): Word[] => [...text.slice(span.start, span.end).matchAll(PHRASE_WORD)].map((found) => ({ text: found[0], index: span.start + found.index }));

/** The noun phrase that follows a claim word: up to six words, ended by a word that opens something else; `kind of` and `type of` go on past their `of`. */
function phraseAfter(text: string, from: number, until: number, claim: string): Word[] {
  const out: Word[] = [];
  const words = wordsAt(text, { start: from, end: until });
  // `differ in <property>`, `identical in their <property>`: what is compared follows the `in`
  const skip = /^(?:differ|var|identical|alike|same)/u.test(claim) && words[0]?.text.toLowerCase() === 'in' ? (/^(?:their|its)$/iu.test(words[1]?.text ?? '') ? 2 : 1) : 0;
  for (const word of words.slice(skip)) {
    const lower = word.text.toLowerCase();
    const afterKind = lower === 'of' && /^(?:kind|type|sort)$/iu.test(out[out.length - 1]?.text ?? '');
    if ((PHRASE_STOP.has(lower) && !afterKind) || out.length === 6) break;
    out.push(word);
  }
  return out;
}

/** The English endings by which a word is made from a stem of a relationship type's word, to name an end of it. */
const ROLE_ENDINGS: ReadonlySet<string> = new Set(['t', 'd', 's', 'ed', 'e', 'es', 'er', 'ers', 'or', 'ors', 'ee', 'ees', 'ing', 'der', 'ders', 'ding']);
const ENDS_LIKE_A_ROLE = /(?:er|or|ee|ing)s?$/u;
const PREPOSITIONS: ReadonlySet<string> = new Set(['by', 'to', 'at', 'of', 'in', 'on', 'from', 'with', 'for', 'under', 'over', 'as', 'into']);

/** The relationship types a word names an end of: the word is the type's words, or a stem of one of them with a fixed ending. */
function relationshipTypesNamedBy(word: string, types: readonly string[]): string[] {
  return types.filter((type) => {
    const whole = flatten(type).trim();
    if (word === whole) return true;
    return whole.split(' ').some((part) => {
      if (PREPOSITIONS.has(part)) return false;
      return [part, part.replace(/(?:ed|d|t|s)$/u, '')].some((stem) => stem.length >= 3 && word.startsWith(stem) && ROLE_ENDINGS.has(word.slice(stem.length)));
    });
  });
}

type Identity = string;
const identityOf = ([type, id]: EntityEnd): Identity => `${type}\u0000${id}`;
const typeOfIdentity = (identity: Identity): string => identity.slice(0, identity.indexOf('\u0000'));

/** A sent relationship with both of its ends told. */
interface Link {
  readonly key: string;
  readonly type: string;
  readonly ends: readonly [Identity, Identity];
}

/** One relationship type taken from one of its two sides: the links of it, each with the end the claim speaks of (near) and the connected one (far). */
interface Group {
  readonly type: string;
  readonly links: readonly { readonly key: string; readonly near: Identity; readonly far: Identity }[];
}

/** What every claim of a sentence is judged over. */
interface Evidence {
  readonly sentence: SummarySentence;
  readonly assembled: CheckedText;
  /** The sentence as written, and the same with quoted texts and the names of elements blanked, of the same length. */
  readonly text: string;
  readonly spoken: string;
  readonly cited: readonly string[];
  /** The entities sent that the sentence names, cited or not, with where it does. */
  readonly named: readonly { readonly key: string; readonly identity: Identity; readonly index: number; readonly end: number }[];
  readonly links: readonly Link[];
}

function evidenceOf(sentence: SummarySentence, assembled: CheckedText): Evidence {
  const text = sentence.text.normalize('NFC');
  const cited = citedElements(sentence, assembled);
  const mentions: { key: string; identity: Identity; index: number; end: number }[] = [];
  const entities = [...(assembled.elementTypes ?? [])].flatMap(([key, type]) => (type.startsWith('entity ') ? [key] : []));
  let spoken = text;
  for (const name of namesOfElements(assembled)) {
    spoken = spoken.replace(new RegExp(`${WB}${ESCAPED(name)}${WE}`, 'giu'), (found, index: number) => {
      // a name that a cited element and one not cited share is the cited one's
      const holders = entities.filter((key) => namesOfKey(key, assembled).includes(name));
      const own = holders.filter((key) => cited.includes(key));
      // an element is spoken of only where its name is written as it is: an id of one letter is not the article
      for (const key of found === name ? (own.length > 0 ? own : holders) : []) {
        const end = assembled.elementEnds?.get(key)?.[0];
        if (end !== undefined) mentions.push({ key, identity: identityOf(end), index, end: index + found.length });
      }
      return ' '.repeat(found.length);
    });
  }
  const links = [...(assembled.elementTypes ?? [])].flatMap(([key, type]): Link[] => {
    const [from, to] = assembled.elementEnds?.get(key) ?? [];
    return type.startsWith('relationship ') && from !== undefined && to !== undefined ? [{ key, type: type.slice('relationship '.length), ends: [identityOf(from), identityOf(to)] }] : [];
  });
  return { sentence, assembled, text, spoken: withoutQuoted(spoken), cited, named: mentions, links };
}

const NUMBER_SAID = `(\\d+|(?:${NUMBER_TENS.join('|')})(?:-(?:${NUMBER_UNITS.slice(1, 10).join('|')}))?|${NUMBER_UNITS.join('|')})`;

/** The number of elements a sentence says it speaks of (`these three`, `all 25`, `seven of them`, `eight links`), nothing when it says none, `several` when it says only that there are more than one. */
function statedCount(evidence: Evidence, nouns: readonly string[]): number | 'several' | undefined {
  // `no two` and `any two` speak of every pair, not of two elements
  const flat = flatten(evidence.spoken).replace(/(?<![\p{L}\p{N}_-])(?:no|any) (?:two|2)(?![\p{L}\p{N}_-])/giu, ' ');
  const noun = [...nouns.map((each) => termPattern(flatten(each).trim())), 'relationships?', 'links?', 'elements?', 'entit(?:y|ies)', 'of them', 'of these', 'of those'].join('|');
  const pointed = new RegExp(`${WB}(?:these|those|all|both)(?:\\s+of)?(?:\\s+(?:the|these|those))?\\s+${NUMBER_SAID}${WE}`, 'iu').exec(flat);
  const counted = new RegExp(`${WB}${NUMBER_SAID}(?:\\s+(?!of\\s)[\\p{L}_]+){0,2}?\\s+(?:${noun})${WE}`, 'iu').exec(flat);
  const said = pointed?.[1] ?? counted?.[1];
  if (said !== undefined) return Number(/^\d+$/u.test(said) ? said : numberWordValue(said));
  if (/(?<![\p{L}\p{N}_-])both(?![\p{L}\p{N}_-])/iu.test(flat)) return 2;
  return /(?<![\p{L}\p{N}_-])(?:several|some)(?![\p{L}\p{N}_-])/iu.test(flat) ? 'several' : undefined;
}

const countHolds = (stated: number | 'several' | undefined, actual: number): boolean => stated === undefined || (stated === 'several' ? actual >= 2 : stated === actual);

/** How a claim is meant: that two of the subjects are the same, that no two are, that not all are, that exactly two are not, or, for a denied difference, that all have one and the same. */
type Reading = 'same' | 'allDifferent' | 'notAllSame' | 'twoDifferent' | 'oneForAll';

/** A denial of a difference (`do not differ`, `no two … differ`, `do not have different …`), which says that all have the same; `not all differ` says something else and is not read. */
const DENIED_DIFFERENCE = /(?:(?:(?<![\p{L}\p{N}_-])(?:not|never)|n['\u2019]t)\s+(?:(?:have|has|be|appear to|seem to)\s+)?|(?<![\p{L}\p{N}_-])(?:no two|none)(?![\p{L}\p{N}_-])(?:(?!(?<![\p{L}])(?:and|or|but|while|which|so)(?![\p{L}]))[^,;.]){0,80}?)(?:differ|differs|different|distinct|vary|varies)(?![\p{L}\p{N}_])/iu;

/** How a claim of a clause reads, with its negation: only the forms listed are read, and any other negated claim is not (undefined). */
function readingOf(kind: ClaimKind, word: string, clause: string, sentence: string): Reading | undefined {
  const flat = flatten(clause);
  const each = /(?<![\p{L}\p{N}_-])(?:each|one another)(?![\p{L}\p{N}_-])/iu.test(flatten(sentence));
  const negated = NEGATION.test(clause);
  if (kind === 'differ') {
    if (negated) return !/(?<![\p{L}\p{N}_-])not\s+all(?![\p{L}\p{N}_-])/iu.test(flat) && DENIED_DIFFERENCE.test(flat) ? 'oneForAll' : undefined;
    return word.startsWith('var') && !each ? 'notAllSame' : 'allDifferent';
  }
  if (!negated) return 'same';
  if (/(?<![\p{L}\p{N}_-])not\s+all(?![\p{L}\p{N}_-])/iu.test(flat)) return 'notAllSame';
  if (/(?<![\p{L}\p{N}_-])(?:no two|none)(?![\p{L}\p{N}_-])/iu.test(flat) || /(?<![\p{L}\p{N}_-])no\s+(?:\S+\s+){1,3}?(?:is|are)\s+(?:shared|the same)(?![\p{L}\p{N}_-])/iu.test(flat)) return 'allDifferent';
  return /(?:(?<![\p{L}\p{N}_-])not|n['’]t)\s+(?:(?:have|has|share|shares)(?![\p{L}\p{N}_-])|the same(?![\p{L}\p{N}_-]))/iu.test(flat) ? 'twoDifferent' : undefined;
}

/** The property keys the cited elements carry whose words stand whole in a phrase, in their singular or plural. */
function propertiesNamed(evidence: Evidence, phrase: string): string[] {
  const keys = [...new Set(evidence.cited.flatMap((key) => (evidence.assembled.rankedValues?.get(key) ?? []).map((entry) => entry.key)))];
  const flat = flatten(phrase);
  return keys.filter((key) => {
    const own = subwordsOf(key);
    return own.length > 0 && (new RegExp(`${WB}${termPattern(own.join(' '))}${WE}`, 'iu').test(own.join(' ') === '' ? '' : flat.replaceAll('-', ' ')) || new RegExp(`${WB}${ESCAPED(key)}(?:s|es)?${WE}`, 'u').test(phrase));
  });
}

/** What a claim compares: a property, the day of a moment, the kind of a link, or connected entities named by their type, a role word or the entity itself. */
type Aspect =
  | { readonly of: 'property'; readonly key: string; readonly end: number }
  | { readonly of: 'day' }
  | { readonly of: 'link' }
  | { readonly of: 'connected'; readonly entityType?: string; readonly relationshipType?: string; readonly nounAt?: Span };

/** The entity types of the mapping that the sent text holds, as elements or as the ends of relationships. */
const entityTypesSent = (evidence: Evidence): string[] => [...new Set([...evidence.assembled.elementEnds?.values() ?? []].flatMap((ends) => ends.map(([type]) => type)))];

/** The entities a sentence names for a claim: those of its clause where they stand; when it names none there, the one that follows it as an apposition (`the same widget, Gamma`); otherwise those of the last clause before it that names one. */
function namedFor(evidence: Evidence, span: Span, subjects: (mention: Evidence['named'][number]) => boolean): Evidence['named'] {
  const within = (each: Span): Evidence['named'] => evidence.named.filter((mention) => mention.index >= each.start && mention.index < each.end);
  const own = within(span).filter((mention) => !subjects(mention));
  if (own.length > 0) return own;
  const following = evidence.named.filter((mention) => mention.index >= span.end && /^[\s,:(]*$/u.test(evidence.text.slice(span.end, mention.index)));
  if (following.length > 0) return following;
  let earlier = span.start;
  for (let back = 0; earlier > 0 && back < MOST_CLAUSES_BACK; back += 1) {
    const before = clauseSpanAt(evidence.spoken, earlier - 1);
    const found = within({ start: before.start, end: earlier });
    if (found.length > 0) return found;
    earlier = before.start;
  }
  return [];
}

/** The aspect a noun phrase names: nothing when it names none, `untestable` when it names something the check cannot test. */
function aspectOf(evidence: Evidence, phrase: readonly Word[], pointed: boolean, named: Evidence['named']): Aspect | 'untestable' | undefined {
  const first = phrase[0];
  const last = phrase[phrase.length - 1];
  if (first === undefined || last === undefined) return undefined;
  const raw = evidence.text.slice(first.index, last.index + last.text.length);
  const flat = flatten(raw);
  if (/(?<![\p{L}\p{N}_-])(?:(?:kind|type|sort) of (?:link|relationship)|relationship type)s?(?![\p{L}\p{N}_-])/iu.test(flat)) return { of: 'link' };
  if (/(?<![\p{L}\p{N}_-])(?:day|date)s?(?![\p{L}\p{N}_-])/iu.test(flat) && propertiesNamed(evidence, raw).length === 0) return { of: 'day' };
  const entityTypes = entityTypesSent(evidence).filter((type) => termIn(type, flat));
  const properties = propertiesNamed(evidence, raw);
  const [property] = properties;
  if (property !== undefined) {
    if (properties.length > 1) return 'untestable';
    // the words of the property end where its last word stands, wherever the phrase goes on
    const lastOwn = subwordsOf(property).at(-1) ?? '';
    const ending = phrase.findLast((word) => subwordsOf(word.text).some((part) => new RegExp(`^${termPattern(lastOwn)}$`, 'iu').test(part))) ?? last;
    return { of: 'property', key: property, end: ending.index + ending.text.length };
  }
  const relationshipTypes = [...new Set(evidence.links.map((link) => link.type))];
  let entityType: string | undefined;
  let relationshipType: string | undefined;
  let other: Word | undefined;
  for (const word of phrase) {
    const lower = word.text.toLowerCase();
    if (FILLER.has(lower)) continue;
    const type = entityTypes.find((candidate) => flatten(candidate).trim().split(' ').some((part) => new RegExp(`^${termPattern(part)}$`, 'iu').test(lower)));
    if (type !== undefined) {
      entityType = type;
      continue;
    }
    const roles = relationshipTypesNamedBy(lower, relationshipTypes);
    const [role] = roles;
    if (role !== undefined) {
      if (roles.length > 1 || (relationshipType !== undefined && relationshipType !== role)) return 'untestable';
      relationshipType = role;
      continue;
    }
    if (ENDS_LIKE_A_ROLE.test(lower)) return 'untestable';
    other = word;
  }
  if (other !== undefined && other === last && entityType === undefined) {
    const beside = named.some((mention) => Math.abs(mention.index - (other.index + other.text.length)) <= 3);
    if (!(pointed || beside) || named.length === 0) return undefined;
    return { of: 'connected', ...(relationshipType === undefined ? {} : { relationshipType }) };
  }
  if (entityType === undefined && relationshipType === undefined) return undefined;
  return { of: 'connected', nounAt: { start: first.index, end: last.index + last.text.length }, ...(entityType === undefined ? {} : { entityType }), ...(relationshipType === undefined ? {} : { relationshipType }) };
}

/** The value of one property of an element as the check compares it: its data class and the exact key of a number or a moment, the text of any other value. Nothing for a value that is missing, masked or not valid in its class. */
function comparedValue(evidence: Evidence, key: string, property: string): { readonly dataClass: string; readonly value: string; readonly text: string } | undefined {
  const sent = evidence.assembled.elementValues?.get(key)?.find((entry) => entry.key === property);
  const ranked = evidence.assembled.rankedValues?.get(key)?.find((entry) => entry.key === property);
  if (sent === undefined || sent.masked || ranked === undefined) return undefined;
  const value = ORDERED_CLASSES.has(ranked.dataClass) ? ranked.value : sent.text;
  return value === undefined ? undefined : { dataClass: ranked.dataClass, value, text: sent.text };
}

/** Whether a value written in a sentence is the value an element holds. */
function writes(literal: string, held: { readonly dataClass: string; readonly value: string; readonly text: string }): boolean {
  if (held.dataClass === 'number') return decimalKey(/^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(literal) ? literal.replaceAll(',', '') : literal) === held.value;
  if (TIME_CLASSES.has(held.dataClass)) return temporalKey(held.dataClass, literal) === held.value || partsOfInstant(held.text).includes(literal);
  return literal.toLowerCase() === held.text.toLowerCase();
}

const STATED_AFTER = /^\s*(?:[,:]\s*|(?:of|is)\s+)?(?:["“]([^"”]+)["”]|(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?|[-+]?\d[\d,]*(?:\.\d+)?)|([\p{L}][\p{L}\p{N}_-]*))/u;

/** The value a sentence writes right after the words of a property: a literal, a quoted text, or a word that is no ordinary word of a sentence. */
function statedValue(text: string, from: number): string | undefined {
  const found = STATED_AFTER.exec(text.slice(from));
  const word = found?.[3]?.toLowerCase();
  if (word !== undefined && (STRUCTURAL_VOCABULARY.has(word) || SENTENCE_OPENERS.has(word) || PHRASE_STOP.has(word) || FILLER.has(word) || new RegExp(`^(?:${CLAIM_WORD.source})$`, 'iu').test(word))) return undefined;
  return found?.[1] ?? found?.[2] ?? found?.[3];
}

/** Every value a sentence lists after the words of a property (`…, A, B and C`): the items up to the end of the sentence, ending at the first item that is neither one word nor a value the elements hold. */
function statedList(text: string, from: number, known: readonly string[]): string[] {
  const rest = /^\s*(?:[,:]|(?:of|is)\s)\s*([^.;!?]*(?:\.\d[^.;!?]*)*)/u.exec(text.slice(from))?.[1] ?? '';
  const out: string[] = [];
  for (const item of rest.split(/,|:|(?<![\p{L}\p{N}_-])(?:and|or)(?![\p{L}\p{N}_-])/iu)) {
    const value = item.trim().replace(/^["\u201c]|["\u201d]$/gu, '');
    if (value === '') continue;
    const held = known.some((each) => each.toLowerCase() === value.toLowerCase());
    const word = value.toLowerCase();
    // `<value> for <name>`, `<value> respectively`: an item that opens with a value an element holds, as whole words, states that value
    const opening = known.filter((each) => word.startsWith(`${each.toLowerCase()} `)).sort((a, b) => b.length - a.length)[0];
    if (!held && opening !== undefined) {
      out.push(opening);
      continue;
    }
    const first = word.split(/\s+/u)[0] ?? '';
    if (!held && (STRUCTURAL_VOCABULARY.has(first) || SENTENCE_OPENERS.has(first) || PHRASE_STOP.has(first) || FILLER.has(first))) break;
    out.push(value);
  }
  return out;
}

/** The cited elements a claim about their properties speaks of: those the sentence names, two or more of one type, or every cited element of the one type that carries the property. */
function propertySubjects(evidence: Evidence, carriers: readonly string[]): string[] | undefined {
  const typeOf = (key: string): string => evidence.assembled.elementTypes?.get(key) ?? '';
  const named = [...new Set(evidence.named.map((mention) => mention.key))];
  if (named.length >= 2 && new Set(named.map(typeOf)).size === 1) return named.every((key) => evidence.cited.includes(key)) ? named : undefined;
  let types = [...new Set(carriers.map(typeOf))];
  if (types.length > 1) types = types.filter((type) => termIn(type.replace(/^(?:entity|relationship) /u, ''), evidence.spoken));
  const [type] = types;
  // an element of the type that the sentence names and does not cite is spoken of and not shown
  if (type === undefined || types.length !== 1 || named.some((key) => typeOf(key) === type && !evidence.cited.includes(key))) return undefined;
  return evidence.cited.filter((key) => typeOf(key) === type);
}

const allEqual = (values: readonly string[]): boolean => new Set(values).size === 1;
const noneEqual = (values: readonly string[]): boolean => new Set(values).size === values.length;

/** Whether values read as a claim reads them. */
function valuesRead(reading: Reading, values: readonly string[]): boolean {
  if (values.length < 2) return false;
  if (reading === 'same' || reading === 'oneForAll') return allEqual(values);
  if (reading === 'notAllSame') return !allEqual(values);
  return noneEqual(values) && (reading !== 'twoDifferent' || values.length === 2);
}

function propertyClaimHolds(evidence: Evidence, meant: Reading, property: string, end: number): boolean {
  const reading: Reading = meant === 'oneForAll' ? 'same' : meant;
  const carriers = evidence.cited.filter((key) => evidence.assembled.rankedValues?.get(key)?.some((entry) => entry.key === property) === true);
  let subjects = propertySubjects(evidence, carriers);
  if (subjects === undefined) return false;
  const nouns = [...new Set(subjects.map((key) => (evidence.assembled.elementTypes?.get(key) ?? '').replace(/^(?:entity|relationship) /u, '')))];
  const stated = statedCount(evidence, nouns);
  const literal = statedValue(evidence.text, end);
  const held = (key: string): ReturnType<typeof comparedValue> => comparedValue(evidence, key, property);
  if (reading === 'same' && literal !== undefined && stated !== undefined) {
    // `shared by seven of them`: the elements that hold the value are the subjects, and the number is theirs
    const holders = subjects.filter((key) => {
      const value = held(key);
      return value !== undefined && writes(literal, value);
    });
    if (!evidence.named.every((mention) => !subjects?.includes(mention.key) || holders.includes(mention.key))) return false;
    subjects = holders;
  }
  const values = subjects.map(held);
  const classes = new Set(values.map((value) => value?.dataClass));
  if (values.some((value) => value === undefined) || classes.size !== 1 || !countHolds(stated, subjects.length)) return false;
  const present = values.flatMap((value) => (value === undefined ? [] : [value]));
  if (literal !== undefined && !(reading === 'same' ? present.every((value) => writes(literal, value)) : present.some((value) => writes(literal, value)))) return false;
  const known = evidence.cited.flatMap((key) => held(key) ?? []);
  if (reading !== 'same' && literal !== undefined && !statedList(evidence.text, end, known.map((value) => value.text)).every((each) => present.some((value) => writes(each, value)))) return false;
  // a value of the property that the sentence writes and no subject holds is a false statement of it
  const others = evidence.cited.flatMap((key) => held(key) ?? []);
  if (others.some((value) => value.dataClass !== 'boolean' && occursWhole(value.text, evidence.text) && !present.some((own) => own.value === value.value))) return false;
  return valuesRead(reading, present.map((value) => value.value));
}

/** Whether the moments of the subjects fall on one day, or on different ones: the date of the one moment property they carry, or of the one the sentence names, all at one offset. */
function dayClaimHolds(evidence: Evidence, reading: Reading): boolean {
  const moments = (key: string): readonly RankedProperty[] => (evidence.assembled.rankedValues?.get(key) ?? []).filter((entry) => TIME_CLASSES.has(entry.dataClass));
  const keys = [...new Set(evidence.cited.flatMap((key) => moments(key).map((entry) => entry.key)))];
  const named = propertiesNamed(evidence, evidence.text).filter((key) => keys.includes(key));
  const [property] = named.length > 0 ? named : keys;
  if (property === undefined || (named.length > 0 ? named : keys).length !== 1) return false;
  const subjects = propertySubjects(evidence, evidence.cited.filter((key) => moments(key).some((entry) => entry.key === property)));
  if (subjects === undefined || !countHolds(statedCount(evidence, []), subjects.length)) return false;
  const values = subjects.map((key) => comparedValue(evidence, key, property));
  const texts = values.flatMap((value) => (value === undefined ? [] : [value.text]));
  if (texts.length !== subjects.length || new Set(texts.map((text) => /(?:Z|[+-]\d{2}:\d{2})$/u.exec(text)?.[0] ?? '')).size !== 1) return false;
  return valuesRead(reading, texts.map((text) => text.slice(0, 10)));
}

function linkClaimHolds(evidence: Evidence, reading: Reading): boolean {
  const cited = evidence.links.filter((link) => evidence.cited.includes(link.key));
  return (reading === 'same' || reading === 'oneForAll') && cited.length >= 2 && allEqual(cited.map((link) => link.type)) && countHolds(statedCount(evidence, cited.map((link) => link.type)), cited.length);
}

/** Both sides of every relationship type the sent text holds. */
function groupsOf(links: readonly Link[]): Group[] {
  return [...new Set(links.map((link) => link.type))].flatMap((type) => ([0, 1] as const).map((near) => ({ type, links: links.filter((link) => link.type === type).map((link) => ({ key: link.key, near: link.ends[near], far: link.ends[near === 0 ? 1 : 0] })) })));
}

/** The connected entities a claim is about: those of a type, or one entity the sentence names. */
interface Connected {
  readonly reaches: (far: Identity) => boolean;
  readonly named: readonly Identity[];
}

/** A group of a claim with its subjects: the near ends of its cited links and the cited entities of a near type that are no far end of them, and the connected entities each is joined to. */
function subjectsOf(evidence: Evidence, group: Group, connected: Connected): { readonly subjects: readonly Identity[]; readonly joined: ReadonlyMap<Identity, ReadonlySet<Identity>> } {
  const cited = group.links.filter((link) => evidence.cited.includes(link.key) && connected.reaches(link.far));
  const fars = new Set(cited.map((link) => link.far));
  const nearTypes = new Set(cited.map((link) => typeOfIdentity(link.near)));
  const entities = evidence.cited.flatMap((key) => {
    const end = evidence.assembled.elementTypes?.get(key)?.startsWith('entity ') === true ? evidence.assembled.elementEnds?.get(key)?.[0] : undefined;
    return end === undefined || !nearTypes.has(end[0]) || fars.has(identityOf(end)) ? [] : [identityOf(end)];
  });
  const subjects = [...new Set([...cited.map((link) => link.near), ...entities])];
  return { subjects, joined: new Map(subjects.map((subject) => [subject, new Set(cited.filter((link) => link.near === subject).map((link) => link.far))])) };
}

/**
 * Whether the links of the groups are complete enough to say that subjects differ, or that only one entity is in common: every sent link that touches a subject is cited, no read that listed one states anything but an exact
 * count, and the sentence says it speaks of what was read or shown, or, where no read listed any of them, points at the few it speaks of.
 */
function completeFor(evidence: Evidence, groups: readonly Group[], subjects: readonly Identity[], connected: Connected): boolean {
  const touching = groups.flatMap((group) => group.links).filter((link) => subjects.includes(link.near) && connected.reaches(link.far));
  if (!touching.every((link) => evidence.cited.includes(link.key))) return false;
  const reads = [...(evidence.assembled.readElements ?? [])].filter(([, listed]) => touching.some((link) => listed.includes(link.key))).map(([read]) => read);
  if (reads.some((read) => evidence.assembled.unknownCountKeys.has(read) || !EXACT_FINDING.test(evidence.assembled.lines.get(read) ?? ''))) return false;
  // a view that states it is not all retrieved is as partial as a filtered read
  const partial = [...(evidence.assembled.readKeys ?? [])].some((key) => /^c\d+$/u.test(key) && (evidence.assembled.unknownCountKeys.has(key) || NOT_EXACT.test(evidence.assembled.lines.get(key) ?? '')));
  return LIMITED_TO_READ.test(evidence.spoken) || (reads.length === 0 && !partial && POINTED_FEW.test(flatten(evidence.spoken)));
}

/** The entities joined to every one of the sets. */
const commonTo = (sets: readonly ReadonlySet<Identity>[]): Identity[] => [...(sets[0] ?? [])].filter((entity) => sets.every((set) => set.has(entity)));

interface ConnectedClaim {
  readonly named: Evidence['named'];
  readonly reading: Reading;
  readonly aspect: Extract<Aspect, { readonly of: 'connected' }>;
  /** The clause that holds the claim word: an entity type written there, other than the one claimed, is the subjects'. */
  readonly clause: string;
  readonly only: boolean;
  /** The part of the sentence that makes the claim, from the end of the one before it to the end of its clause. */
  readonly within: Span;
  /** Whether a name of the sentence speaks of a subject: one before the claim word in its clause. */
  readonly ofSubjects: (mention: Evidence['named'][number]) => boolean;
  /** Whether the same connected entities, in the plural, are claimed of every subject. */
  readonly everyOne: boolean;
  /** Whether the connected entities themselves are what differ (`three different widgets`, `the widgets differ`). */
  readonly themselves: boolean;
}

function connectedClaimHolds(evidence: Evidence, claim: ConnectedClaim): boolean {
  const { aspect, reading } = claim;
  // an entity the sentence names, of the type claimed (or of any when the claim points to it), must be the one that is shared
  // the connected entities that differ are all the sentence names; a shared one is what is named for the claim
  const typed = (claim.themselves ? evidence.named.filter((mention) => mention.index >= claim.within.start && mention.index < claim.within.end) : claim.named).filter((mention) => aspect.entityType === undefined || mention.identity.startsWith(`${aspect.entityType}\u0000`));
  const connected: Connected = { reaches: (far) => aspect.entityType === undefined || typeOfIdentity(far) === aspect.entityType, named: [...new Set(typed.map((mention) => mention.identity))] };
  const subjectTypes = entityTypesSent(evidence).filter((type) => type !== aspect.entityType && termIn(type, claim.clause));
  const groups = groupsOf(evidence.links)
    .filter((group) => aspect.relationshipType === undefined || group.type === aspect.relationshipType)
    .map((group) => ({ group, ...subjectsOf(evidence, group, connected) }))
    .filter((each) => each.subjects.length > 0);
  if (claim.themselves) return themselvesDiffer(evidence, aspect, groups.map((each) => each.group), connected);
  const stated = statedCount(evidence, [...subjectTypes, ...(aspect.relationshipType === undefined ? [] : [aspect.relationshipType])]);
  const flat = flatten(evidence.spoken);
  const ofLinks = reading !== 'same' && /(?<![\p{L}\p{N}_-])(?:relationships?|links?)(?![\p{L}\p{N}_-])/iu.test(flat) && (stated !== undefined || /(?<![\p{L}\p{N}_-])each(?![\p{L}\p{N}_-])/iu.test(flat));
  if (ofLinks) {
    const cited = evidence.links.filter((link) => evidence.cited.includes(link.key) && (aspect.relationshipType === undefined || link.type === aspect.relationshipType));
    const fars = cited.map((link) => [link.ends[1], link.ends[0]].find((end) => connected.reaches(end)));
    return cited.length >= 2 && countHolds(stated, cited.length) && fars.every((far) => far !== undefined) && noneEqual(fars.map((far) => far ?? ''));
  }
  // of the two sides of a type, the one the claim speaks from has two or more subjects, of the type the sentence names for them when it names one, and the connected entity is none of them
  const sided = groups.filter((each) => each.subjects.length >= 2 && !each.subjects.some((subject) => connected.named.includes(subject) && aspect.entityType === undefined) && (subjectTypes.length === 0 || each.subjects.some((subject) => subjectTypes.includes(typeOfIdentity(subject)))));
  // every entity the sentence names of the subjects' type is a subject or one it is joined to; one named before the claim word, in its clause, is a subject
  const spokenOf = (each: (typeof sided)[number]): boolean => {
    const fars = new Set([...each.joined.values()].flatMap((set) => [...set]));
    const nearTypes = new Set(each.subjects.map(typeOfIdentity));
    return evidence.named.every(
      (mention) =>
        (!claim.ofSubjects(mention) || each.subjects.includes(mention.identity)) &&
        (mention.index < claim.within.start || mention.index >= claim.within.end || !nearTypes.has(typeOfIdentity(mention.identity)) || each.subjects.includes(mention.identity) || fars.has(mention.identity)),
    );
  };
  if (claim.only) return sided.every(spokenOf) && onlyOneShared(evidence, claim, sided, connected);
  if (reading === 'same' && claim.everyOne) {
    return sided.some((each) => {
      const sets = each.subjects.map((subject) => each.joined.get(subject) ?? new Set<Identity>());
      const [first] = sets;
      return spokenOf(each) && first !== undefined && first.size > 0 && sets.every((set) => set.size === first.size && [...set].every((entity) => first.has(entity))) && countHolds(stated, each.subjects.length) && completeFor(evidence, [each.group], each.subjects, connected);
    });
  }
  if (reading === 'oneForAll') {
    // a denied difference: every subject is joined to one and the same entity, by every link of the type that was sent for it
    return sided.some((each) => {
      const sets = each.subjects.map((subject) => each.joined.get(subject) ?? new Set<Identity>());
      const only = new Set(sets.flatMap((set) => [...set]));
      const every = each.group.links.filter((link) => each.subjects.includes(link.near) && connected.reaches(link.far)).every((link) => evidence.cited.includes(link.key));
      return spokenOf(each) && only.size === 1 && sets.every((set) => set.size === 1) && every && countHolds(stated, each.subjects.length) && connected.named.filter((named) => !each.subjects.includes(named)).every((named) => only.has(named));
    });
  }
  if (reading === 'same') {
    return sided.some((each) => {
      if (!spokenOf(each)) return false;
      const sets = each.subjects.map((subject) => each.joined.get(subject) ?? new Set<Identity>());
      const common = commonTo(sets);
      return common.length > 0 && connected.named.filter((named) => !each.subjects.includes(named)).every((named) => common.includes(named)) && countHolds(stated, each.subjects.length);
    });
  }
  if (sided.length === 0) return false;
  return sided.every((each) => {
    const sets = each.subjects.map((subject) => [...(each.joined.get(subject) ?? [])]);
    const all = sets.flat();
    const apart = reading === 'notAllSame' ? commonTo(sets.map((set) => new Set(set))).length === 0 : noneEqual(all);
    return spokenOf(each) && sets.every((set) => set.length > 0) && apart && (reading !== 'twoDifferent' || each.subjects.length === 2) && countHolds(stated, each.subjects.length) && completeFor(evidence, [each.group], each.subjects, connected);
  });
}

/** `three different widgets`: the cited links of one side reach, or with none the sentence cites, as many distinct entities as it states or names, and two or more. */
function themselvesDiffer(evidence: Evidence, aspect: Extract<Aspect, { readonly of: 'connected' }>, groups: readonly Group[], connected: Connected): boolean {
  const said = new RegExp(`${WB}${NUMBER_SAID}(?![\\p{L}\\p{N}_])`, 'iu').exec(flatten(evidence.spoken))?.[1];
  const wanted = said === undefined ? (connected.named.length >= 2 ? connected.named.length : undefined) : Number(/^\d+$/u.test(said) ? said : numberWordValue(said));
  const holds = (count: number): boolean => count >= 2 && (wanted === undefined || count === wanted);
  const reached = (group: Group): Set<Identity> => new Set(group.links.filter((link) => evidence.cited.includes(link.key) && connected.reaches(link.far)).map((link) => link.far));
  if (groups.every((group) => reached(group).size === 0)) {
    // with no cited relationship that reaches them, the sentence cites the entities themselves
    if (aspect.entityType === undefined) return false;
    const entities = evidence.cited.filter((key) => evidence.assembled.elementTypes?.get(key) === `entity ${aspect.entityType}`);
    return holds(new Set(entities.map((key) => identityOf(evidence.assembled.elementEnds?.get(key)?.[0] ?? ['', key]))).size);
  }
  return groups.some((group) => {
    const fars = reached(group);
    return connected.named.every((named) => fars.has(named) || group.links.some((link) => link.near === named)) && holds(fars.size);
  });
}

/** `the only shared …`: exactly one connected entity is joined to two or more subjects over every group that touches them, each complete, and it is the one named, or of the role named. */
function onlyOneShared(evidence: Evidence, claim: ConnectedClaim, sided: readonly (ReturnType<typeof subjectsOf> & { readonly group: Group })[], connected: Connected): boolean {
  const subjects = [...new Set(sided.flatMap((each) => each.subjects))];
  const every = groupsOf(evidence.links).filter((group) => claim.aspect.relationshipType === undefined || group.type === claim.aspect.relationshipType);
  const touching = every.filter((group) => group.links.some((link) => subjects.includes(link.near) && connected.reaches(link.far) && !subjects.includes(link.far)));
  if (touching.length === 0 || !completeFor(evidence, touching, subjects, connected)) return false;
  const joined = new Map<Identity, Set<Identity>>();
  for (const link of touching.flatMap((group) => group.links)) {
    if (!subjects.includes(link.near) || !connected.reaches(link.far)) continue;
    joined.set(link.far, (joined.get(link.far) ?? new Set()).add(link.near));
  }
  const shared = [...joined].filter(([, near]) => near.size >= 2);
  const [only] = shared;
  if (only === undefined || shared.length !== 1 || !connected.named.every((named) => named === only[0])) return false;
  // `the only shared widget is the sender`: the role said of it is one it is shared through
  const said = /(?<![\p{L}\p{N}_-])is\s+(?:the\s+)?([\p{L}\p{N}_]+)/iu.exec(evidence.spoken.slice(evidence.spoken.search(/(?<![\p{L}\p{N}_-])only(?![\p{L}\p{N}_-])/iu)))?.[1]?.toLowerCase();
  if (said === undefined || FILLER.has(said)) return true;
  const roles = relationshipTypesNamedBy(said, [...new Set(evidence.links.map((link) => link.type))]);
  if (roles.length === 0) return !ENDS_LIKE_A_ROLE.test(said);
  return touching.some((group) => roles.includes(group.type) && group.links.some((link) => link.far === only[0] && subjects.includes(link.near)));
}

/** Whether a claim word that is part of a property's own name (`is not shared`) agrees with the true or false value of the one cited element that carries it. Undefined when it is no such name. */
function ownNameHolds(evidence: Evidence, claim: Span & { readonly word: string }): boolean | undefined {
  const after = evidence.spoken.slice(claim.end);
  if (!/^\s*(?:$|[.,;:]|(?:and|or|but)(?![\p{L}\p{N}_-]))/iu.test(after)) return undefined;
  const carriers = evidence.cited.flatMap((key) => (evidence.assembled.elementValues?.get(key) ?? []).filter((entry) => subwordsOf(entry.key).includes(claim.word)).map((entry) => entry));
  const [only] = carriers;
  if (only === undefined) return undefined;
  if (carriers.length !== 1 || only.masked || (only.text !== 'true' && only.text !== 'false')) return false;
  const negated = /(?:(?<![\p{L}\p{N}_-])(?:not|never|nor)|n['’]t)\s+(?:[\p{L}]+\s+)?$/iu.test(evidence.spoken.slice(0, claim.start));
  return negated === (only.text === 'false');
}

/** Whether the words claim nothing of the elements: a sentence that cites none and restates a meaning or a read, or words that point back to the one cited element of a type. */
function claimsNothing(evidence: Evidence, claim: Span & { readonly word: string }): boolean | undefined {
  const { sentence, assembled, spoken, text } = evidence;
  if (evidence.cited.length === 0) {
    if (sentence.cites.every((cite) => assembled.descriptionKeys?.has(cite) === true)) return true;
    const lines = sentence.cites.filter((cite) => assembled.readKeys?.has(cite) === true).map((cite) => flatten(assembled.lines.get(cite) ?? '').replaceAll('-', ' '));
    const [next] = wordsAt(text.replaceAll('-', ' '), { start: claim.end, end: text.length });
    if (next === undefined || lines.length === 0) return false;
    return /^(?:read|reads|result|results)$/iu.test(next.text) || lines.some((line) => line.includes(`${claim.word} ${next.text.toLowerCase()}`));
  }
  if (!/^\s*(?:the|that)\s+$/iu.test(spoken.slice(0, claim.start)) || claim.word !== 'same') return undefined;
  const following = spoken.slice(claim.end).trimStart();
  const types = [...new Set(evidence.cited.map((key) => assembled.elementTypes?.get(key) ?? ''))].filter((type) => typeWordLength(following, elementTypeName(type)) !== undefined);
  const [type] = types;
  if (type === undefined) return undefined;
  if (!type.startsWith('entity ')) return evidence.cited.filter((key) => assembled.elementTypes?.get(key) === type).length === 1 ? true : undefined;
  // one entity of the type among the cited elements and the ends of the cited relationships together: a second one reached by a link leaves it open which is meant
  const held = new Set(evidence.cited.flatMap((key) => (assembled.elementEnds?.get(key) ?? []).filter(([ofType]) => `entity ${ofType}` === type).map(identityOf)));
  return held.size === 1 ? true : undefined;
}

/** The aspect a claim word names before it: in its own clause, or in the nearest clause before it that names one. */
function earlierAspect(evidence: Evidence, span: Span, before: readonly Word[], named: Evidence['named'], pointed: (phrase: readonly Word[]) => boolean): Aspect | 'untestable' | undefined {
  const nouns = (words: readonly Word[]): Word[] => words.filter((each) => !PHRASE_STOP.has(each.text.toLowerCase()) || /^(?:of|that)$/iu.test(each.text)).slice(-6);
  let words = before;
  let from = span.start;
  for (let back = 0; ; back += 1) {
    const phrase = nouns(words);
    const aspect = aspectOf(evidence, phrase, pointed(phrase), named);
    if (aspect !== undefined || from === 0 || back === MOST_CLAUSES_BACK) return aspect;
    const earlier = clauseSpanAt(evidence.spoken, from - 1);
    words = wordsAt(evidence.spoken, { start: earlier.start, end: from });
    from = earlier.start;
  }
}

/** Whether the last word of a noun phrase is a plural: of the entity type claimed, never its own name (which may end in an s), or of a word made as a role word is. */
function isPlural(noun: string, entityType: string | undefined): boolean {
  if (entityType === undefined) return /(?:er|or|ee)s$/u.test(noun);
  const own = flatten(entityType).trim().split(' ').at(-1) ?? '';
  return noun !== own && new RegExp(`^${termPattern(own)}$`, 'iu').test(noun);
}

/** Words that may stand before `are different` or `differ` when the connected entities alone are the subject, beside their type and role words. */
const BARE_SUBJECT: ReadonlySet<string> = new Set([...FILLER, 'are', 'is', 'and', 'each', 'others', 'which', 'they', 'among', 'their']);

/** Whether the connected entities themselves are the subject of the claim (`these three <entities> are different`, `which are different <entities>`), and not what the subjects have (`the <entities> of A and B differ`). */
function entitiesAreSubject(evidence: Evidence, span: Span, claim: Span, entityType: string, predicative: boolean): boolean {
  const said = /(?<![\p{L}\p{N}_-])(?:are|is)\s+(?:[\p{L}\p{N}_-]+\s+)?$/iu.test(evidence.spoken.slice(span.start, claim.start));
  if (!said && !(predicative && /^\s*(?:$|[.,;:]|from(?![\p{L}\p{N}_-]))/iu.test(evidence.spoken.slice(claim.end)))) return false;
  if (evidence.named.some((mention) => mention.index >= span.start && mention.index < claim.start)) return false;
  const types = [...new Set(evidence.links.map((link) => link.type))];
  const before = evidence.spoken.slice(span.start, claim.start).replace(new RegExp(LIMITED_TO_READ.source, 'giu'), ' ').replace(/(?<![\p{L}\p{N}_-])in the sample(?![\p{L}\p{N}_-])/giu, ' ');
  return [...before.matchAll(PHRASE_WORD)].every(([found]) => {
    const word = found.toLowerCase();
    return BARE_SUBJECT.has(word) || new RegExp(`^${termPattern(flatten(entityType).trim())}$`, 'iu').test(word) || relationshipTypesNamedBy(word, types).length > 0;
  });
}

/** The items of a list that follows `differ in`: split at commas, `and` and `or` outside parentheses, up to the end of the sentence, each with the examples written in parentheses after it. */
function listedItems(text: string, from: number): { readonly raw: string; readonly words: string; readonly examples: readonly string[] }[] {
  const items: { raw: string; words: string; examples: string[] }[] = [];
  const segment = /^(?:[^.;!?(]|\([^)]*\)|\.(?=\d))*/u.exec(text.slice(from))?.[0] ?? '';
  const turn = /(?<![\p{L}\p{N}_-])(?:but|while|whereas|so|yet|although)(?![\p{L}\p{N}_-])(?![^(]*\))/iu.exec(segment);
  for (const piece of segment.slice(0, turn?.index ?? segment.length).split(/(?:,|(?<![\p{L}\p{N}_-])(?:and|or|as\s+well\s+as)(?![\p{L}\p{N}_-]))(?![^()]*\))/iu)) {
    const examples = [...piece.matchAll(/\(([^)]*)\)/gu)].flatMap((found) => (found[1] ?? '').replace(/^\s*(?:for example|for instance|e\.g\.|such as|including)[\s,:]*/iu, '').split(/(?<!\d),|,(?!\d{3}(?!\d))|(?<![\p{L}\p{N}_-])(?:and|or)(?![\p{L}\p{N}_-])/iu)).map((example) => example.trim().replace(/^["\u201c]|["\u201d]$/gu, '')).filter((example) => example !== '' && !/^etc/iu.test(example));
    const words = piece.replace(/\([^)]*\)/gu, ' ').trim().replace(/^(?:(?:in|their|its|the|also|each|one|all)\s+)+/iu, '');
    if (words !== '') items.push({ raw: piece.trim(), words, examples });
  }
  return items;
}

/** The words that open another assertion after a list: a subject, or a verb of having or being or of comparison, which is judged by itself. */
const OPENS_ANOTHER: ReadonlySet<string> = new Set(['both', 'they', 'it', 'these', 'those', 'none', 'then', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'use', 'uses', 'used', 'share', 'shares', 'shared', 'differ', 'differs', 'vary', 'varies', 'come', 'comes', 'came', 'show', 'shows', 'include', 'includes']);

/** An item that goes on about the claim after a list, and names no further property: a phrase that limits it to what was read, or one that opens with a relative or prepositional word other than `in`, or with a figure. */
const GOES_ON = /^(?:(?:as|at|which|that|where|when|with|by|from|to|for|according|per)(?![\p{L}\p{N}_-])|\d)/iu;
const afterTheList = (raw: string): boolean => GOES_ON.test(raw) || new RegExp(`^(?:${LIMITED_TO_READ.source})`, 'iu').test(raw) || /^among\s+those\s+read/iu.test(raw);

/**
 * `differ in A, B and C`: each property named is a claim of its own, that the subjects do not all hold the same value of it (no two the same with `each`). An example in parentheses that a subject holds stands; one that only an
 * element not cited holds is passed over; one no element holds is false. Undefined when what follows `in` names no property, which is judged as any other claim.
 */
function differsInHolds(evidence: Evidence, claimEnd: number, reading: Reading): boolean | undefined {
  const lead = /^\s+in(?![\p{L}\p{N}_-])/iu.exec(evidence.spoken.slice(claimEnd));
  if (lead === null) return undefined;
  const from = claimEnd + lead[0].length;
  const items = listedItems(evidence.text.slice(0, from + LONGEST_LIST + 1), from);
  const named = items.map((item) => propertiesNamed(evidence, item.words));
  if ((named[0]?.length ?? 0) === 0) return undefined;
  if (items.length > MOST_LISTED || (evidence.text.length - from > LONGEST_LIST && items.length > 1)) return false;
  const ends = items.findIndex((item, index) => index > 0 && ((named[index]?.length === 0 && afterTheList(item.raw)) || OPENS_ANOTHER.has(item.words.split(/\s+/u)[0]?.toLowerCase() ?? '')));
  return items.slice(0, ends < 0 ? items.length : ends).every((item, index) => {
    const [property, other] = named[index] ?? [];
    if (property === undefined || other !== undefined) return false;
    const subjects = propertySubjects(evidence, evidence.cited.filter((key) => evidence.assembled.rankedValues?.get(key)?.some((entry) => entry.key === property) === true));
    if (subjects === undefined || !countHolds(statedCount(evidence, []), subjects.length)) return false;
    const values = subjects.map((key) => comparedValue(evidence, key, property));
    const present = values.flatMap((value) => (value === undefined ? [] : [value]));
    if (present.length !== subjects.length || new Set(present.map((value) => value.dataClass)).size !== 1 || !valuesRead(reading, present.map((value) => value.value))) return false;
    const sent = [...(evidence.assembled.elementTypes?.keys() ?? [])].flatMap((key) => comparedValue(evidence, key, property) ?? []);
    return item.examples.every((example) => sent.some((value) => writes(example, value)));
  });
}

/**
 * A sentence that says elements differ, are the same or share something is kept only when the cited elements show it: equal or unequal values of a property they carry, the day of their moments, the type of their links, or the
 * entities they are joined to by the cited relationships. A claim the check cannot test is not verified. Property, type and relationship names are the mapping's; nothing here is a word of a domain.
 */
function comparisonClaimsHold(sentence: SummarySentence, assembled: CheckedText): boolean {
  if (sentence.text.normalize('NFC').search(new RegExp(CLAIM_WORD.source, 'iu')) < 0) return true;
  const evidence = evidenceOf(sentence, assembled);
  const claims = [...evidence.spoken.matchAll(CLAIM_WORD)];
  if (claims.length > MOST_CLAIMS) return false;
  return claims.every((found) => {
    const word = found[0].toLowerCase();
    const claim = { start: found.index, end: found.index + found[0].length, word };
    const span = clauseSpanAt(evidence.spoken, found.index);
    const clause = evidence.spoken.slice(span.start, span.end);
    if (saysItCannotBeTold(clause, found.index - span.start, evidence.text.slice(span.start, span.end))) return true;
    const nothing = claimsNothing(evidence, claim);
    if (nothing !== undefined) return nothing;
    const stops = [...evidence.spoken.slice(0, claim.start).matchAll(/[.;!?](?!\d)/gu)];
    const within = { start: stops.at(-1)?.index ?? 0, end: span.end };
    const ownName = ownNameHolds(evidence, claim);
    if (ownName !== undefined) return ownName;
    const kind = kindOfClaim(word);
    if (kind === 'differ' && /^(?:differ|var)/u.test(word)) {
      const each = /(?<![\p{L}\p{N}_-])(?:each|one another)(?![\p{L}\p{N}_-])/iu.test(evidence.spoken);
      // `differ in` says that not all hold one value of each property (no two with `each`); denied, that all hold one; any other negation is not read
      const meant: Reading | undefined = NEGATION.test(clause) ? readingOf(kind, word, clause, evidence.spoken) : each ? 'allDifferent' : 'notAllSame';
      const listed = meant === undefined ? undefined : differsInHolds(evidence, claim.end, meant);
      if (listed !== undefined) return listed;
    }
    const before = wordsAt(evidence.spoken, { start: span.start, end: claim.start });
    const only = kind !== 'differ' && /(?<![\p{L}\p{N}_-])only(?![\p{L}\p{N}_-])/iu.test(evidence.spoken.slice(span.start, claim.start));
    const reading = readingOf(kind, word, clause, evidence.spoken);
    if (reading === undefined) return false;
    // the noun phrase the claim word governs, or, when it governs none, the one before it in its clause or in the sentence
    const common = word === 'in common' || word === 'common to';
    const after = common ? [] : phraseAfter(evidence.spoken, claim.end, span.end, word);
    const pointed = (phrase: readonly Word[]): boolean => /(?<![\p{L}\p{N}_-])(?:that|this|the one)(?![\p{L}\p{N}_-])/iu.test(phrase.map((each) => each.text).join(' '));
    // a name before the claim word in its clause is a subject's, unless the clause says it is the shared one (`<name> is the shared …`)
    const ofSubjects = (mention: Evidence['named'][number]): boolean =>
      !common && mention.index >= span.start && mention.end <= claim.start && !/^\s*(?:is|was)\s+(?:(?:the|a|an|that|their|one)\s+)*(?:only\s+)?$/iu.test(evidence.text.slice(mention.end, claim.start));
    const named = namedFor(evidence, span, ofSubjects);
    // the claim word governs the name of an entity: that entity is the connected one (`share <name>`, `<name> is common to`, `have <name> in common`)
    const saidOf = (mention: Evidence['named'][number], between: RegExp): boolean => mention.index >= span.start && mention.end <= claim.start && between.test(evidence.text.slice(mention.end, claim.start));
    const governed = evidence.named.filter(
      (mention) =>
        (common && saidOf(mention, /^\s*(?:(?:is|are)\s+)?$/iu)) ||
        // `<name> is shared by …`, `<name> is the same for …`
        (/^shared$/u.test(word) && saidOf(mention, /^\s*(?:is|was)\s+(?:the\s+)?$/iu) && /^\s*(?:by|among|between)(?![\p{L}\p{N}_-])/iu.test(evidence.spoken.slice(claim.end))) ||
        (word === 'same' && saidOf(mention, /^\s*(?:is|was)\s+the\s+$/iu) && /^\s*for(?![\p{L}\p{N}_-])/iu.test(evidence.spoken.slice(claim.end))) ||
        (!common && kind !== 'differ' && mention.index >= claim.end && /^\s*(?:(?:the|that|this)\s+)?$/iu.test(evidence.text.slice(claim.end, mention.index))),
    );
    if (governed.length > 0) return connectedClaimHolds(evidence, { named: governed, reading, aspect: { of: 'connected' }, clause, only, themselves: false, everyOne: false, ofSubjects: (mention) => !governed.includes(mention) && ofSubjects(mention), within });
    let aspect = aspectOf(evidence, after, pointed(after), named);
    let predicative = false;
    if (aspect === undefined) {
      aspect = earlierAspect(evidence, span, before, named, pointed);
      predicative = true;
    }
    if (aspect === undefined || aspect === 'untestable') return false;
    if (aspect.of === 'property') return propertyClaimHolds(evidence, reading, aspect.key, aspect.end);
    if (aspect.of === 'day') return dayClaimHolds(evidence, reading);
    if (aspect.of === 'link') return linkClaimHolds(evidence, reading);
    const numberBefore = new RegExp(`${WB}${NUMBER_SAID}\\s+$`, 'iu').test(evidence.spoken.slice(0, claim.start));
    const themselves = kind === 'differ' && aspect.entityType !== undefined && reading === 'allDifferent' && (numberBefore || entitiesAreSubject(evidence, span, claim, aspect.entityType, predicative));
    // `the same <entities>`, in the plural, says it of every subject
    const noun = aspect.nounAt === undefined ? '' : evidence.spoken.slice(aspect.nounAt.start, aspect.nounAt.end);
    const everyOne = /^(?:same|identical|alike)$/u.test(word) && isPlural(noun.split(/\s+/u).at(-1)?.toLowerCase() ?? '', aspect.entityType);
    return connectedClaimHolds(evidence, { named, reading, aspect, clause, only, themselves, everyOne, ofSubjects, within });
  });
}

function comparisonHolds(sentence: SummarySentence, assembled: CheckedText): boolean {
  return comparedElementsHold(sentence, assembled) && rankingHolds(sentence, assembled) && rangeHolds(sentence, assembled) && gapClaimsHold(sentence, assembled) && comparisonClaimsHold(sentence, assembled) && claimsAreBacked(sentence, assembled);
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
  // a quoted date or time that is an exact part of an instant of the text sent is found where that instant stands
  for (const quoted of text.matchAll(QUOTED)) if (!occursWhole(quoted[1] ?? '', sent) && !isTemporalPartOf(quoted[1] ?? '', [sent])) return false;
  // a decimal point between digits is not the end of a sentence: it is taken out so that what follows is not read as the start of one
  const unquoted = text.replace(QUOTED, ' ').replace(/(\d)\.(\d)/gu, '$1 $2');
  for (const token of unquoted.match(IDENTIFIER_LIKE) ?? []) {
    // a word joined with underscores between letters or digits is one name (a relationship type): it is found whole in the text sent, never as a mix of the parts of others; Markdown emphasis around a word is not one
    if (!sentTokens.has(token) && token.split('-').some((part) => /[\p{L}\p{N}]_[\p{L}\p{N}]/u.test(part) && !known.has(part.replace(/^_+|_+$/gu, '').toLowerCase()))) return false;
    if (!/\d/.test(token) || !/[\p{L}_-]/u.test(token)) continue;
    // a date written as a part of an instant of the text sent is no identifier to find whole
    if (!sentTokens.has(token) && !isTemporalPartOf(token, [sent])) return false;
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
  if (!comparedElementsHold(sentence, assembled) || !rankingHolds(sentence, assembled) || !rangeHolds(sentence, assembled) || !gapClaimsHold(sentence, assembled) || !comparisonClaimsHold(sentence, assembled)) return 'comparison';
  if (!claimsAreBacked(sentence, assembled)) return 'citation';
  return 'name';
}

/** A sentence that opens on what is left of a set an earlier sentence spoke of (`the other four`, `the rest`, `the remaining`), with no set of its own to rest on. */
const LEFT_OF_A_SET = /^\s*(?:(?:all|both|of)\s+)?(?:the\s+)?(?:other|others|rest|remaining|remainder)(?![\p{L}\p{N}_-])/iu;

/** The reason the sentence before this one was removed, when this one says what is left of a set that sentence spoke of (it cites an element that sentence cites): it is removed with it, since its set is no longer in the answer. */
function dependsOnRemoved(sentence: SummarySentence, previous: { readonly cites: ReadonlySet<string>; readonly reason: RemovalReason } | undefined): RemovalReason | undefined {
  if (previous === undefined || !LEFT_OF_A_SET.test(sentence.text) || !sentence.cites.some((key) => previous.cites.has(key))) return undefined;
  return previous.reason === 'verdict' || previous.reason === 'key' ? 'citation' : previous.reason;
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
  let previous: { readonly cites: ReadonlySet<string>; readonly reason: RemovalReason } | undefined;
  for (const original of sentences) {
    // a sentence far longer than any answer writes is not read at all: several of the checks take time that grows faster than its length
    if (original.text.length > LONGEST_SENTENCE) {
      removed += 1;
      rejected.push({ text: original.text, reason: 'length' });
      previous = { cites: new Set(original.cites), reason: 'length' };
      continue;
    }
    if (holdsVerdict(original, assembled)) {
      verdictFound = true;
      removed += 1;
      rejected.push({ text: original.text, reason: 'verdict' });
      previous = { cites: new Set(original.cites), reason: 'verdict' };
      continue;
    }
    const clean = withoutKeys(original.text, assembled);
    if (clean === undefined) {
      removed += 1;
      keysRemoved += 1;
      rejected.push({ text: original.text, reason: 'key' });
      previous = { cites: new Set(original.cites), reason: 'key' };
      continue;
    }
    const sentence = clean.stripped ? { ...original, text: clean.text } : original;
    const failing = !citationsHold(sentence, assembled) || !numbersHold(sentence, assembled, options.tableRows !== true) || !comparisonHolds(sentence, assembled) || !namesHold(sentence, namesScopeOf(sentence, assembled));
    const dependent = failing ? undefined : dependsOnRemoved(sentence, previous);
    if (failing || dependent !== undefined) {
      removed += 1;
      const reason = dependent ?? removalReasonOf(sentence, assembled, options.tableRows !== true);
      rejected.push({ text: original.text, reason });
      previous = { cites: new Set(original.cites), reason };
    } else {
      kept.push(sentence);
      previous = undefined;
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
