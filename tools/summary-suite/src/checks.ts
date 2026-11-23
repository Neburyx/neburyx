import { createHash } from 'node:crypto';
import type { CaseSummaryOutcome, SummarySentence } from '@neburyx/contracts';
import { z } from 'zod';

export class SuiteCheckFailed extends Error {}

const fail = (message: string): never => {
  throw new SuiteCheckFailed(message);
};

/** The value, or a failure that says what was missing: the tests look things up in sets they built and never assert a type over a hole. */
export function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new SuiteCheckFailed(`${what} is missing`);
  return value;
}

/** The sentences of a draft: an answer that is `ok` or `partial` holds them, any other answer holds none. */
export function sentencesOf(outcome: CaseSummaryOutcome): readonly SummarySentence[] {
  // `storable` is the notes' concern (tested with the notes); this suite compares what the checks kept
  return outcome.status === 'ok' || outcome.status === 'partial' ? outcome.sentences.map(({ text, cites }) => ({ text, cites })) : [];
}

export function keysOfSentText(sent: string): Set<string> {
  return new Set([...sent.matchAll(/^([ne]\d+) \|/gmu)].map((match) => defined(match[1], 'a key')));
}

function linesOfKeys(sent: string): Map<string, string> {
  return new Map(sent.split('\n').flatMap((line) => (/^[ne]\d+ \|/u.test(line) ? [[line.slice(0, line.indexOf(' ')), line] as const] : [])));
}

export function keyOfRelationship(sent: string, type: string): string {
  const line = sent.split('\n').find((candidate) => /^e\d+ \|/u.test(candidate) && candidate.includes(`${JSON.stringify(type)} |`));
  return defined(line?.slice(0, line.indexOf(' ')), `the relationship of type ${type}`);
}

/** Every string the value holds, at any depth, as it is and not as JSON writes it. */
function leavesOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(leavesOf);
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([key, entry]) => [key, ...leavesOf(entry)]);
  return [];
}

/** No record holds a sentinel: each string of the records is searched as it is, so a text with a line break, a quote or a control character is found. */
export function expectNoText(records: readonly unknown[], sentinels: readonly string[]): void {
  const leaves = leavesOf(records);
  for (const sentinel of sentinels) if (leaves.some((leaf) => leaf.includes(sentinel))) fail(`a record holds text that must not be recorded: ${JSON.stringify(sentinel)}`);
}

/** Every sentence cites at least one key, and every key it cites was sent. */
export function expectCited(sentences: readonly SummarySentence[], sentKeys: ReadonlySet<string>): void {
  for (const sentence of sentences) {
    if (sentence.cites.length === 0) fail(`a sentence cites nothing: ${sentence.text}`);
    for (const key of sentence.cites) if (!sentKeys.has(key)) fail(`a sentence cites a key that was not sent: ${key}`);
  }
}

/** The text equals the expected text, which a test writes by hand and never takes from the code under test. */
export function expectSameText(actual: string, expected: string): void {
  if (actual !== expected) fail(`the text differs from the expected text:\n--- actual\n${actual}\n--- expected\n${expected}`);
}

/** The id appears on exactly one line of the sent text: an element is sent under one key. */
export function expectEachIdOnce(sent: string, ids: readonly string[]): void {
  for (const id of ids) {
    const count = sent.split('\n').filter((line) => line.includes(`id: ${JSON.stringify(id)}`)).length;
    if (count !== 1) fail(`the id ${id} is sent ${count} times`);
  }
}

/** The vocabulary of guilt, fraud, crime, intent, conclusion and proof that neither a reply nor the typology may use. Written here apart from the product's list. */
const OFFENCE = /\b(?:guilt\w*|fraud\w*|launder\w*|crim\w*|offen[cs]e\w*|offender\w*|perpetrator\w*|culprit\w*|suspect\w*|suspic\w*|intent\w*|deliberate\w*|illegal\w*|unlawful\w*|convict\w*|conclud\w*|conclusion\w*|proves?|proof|responsible\s+for)\b/iu;

export function offenceWordsIn(text: string): string[] {
  return text.match(new RegExp(OFFENCE.source, 'giu')) ?? [];
}

const TITLE_AND_ID = /\| title: ("(?:[^"\\]|\\.)*") \| id: ("(?:[^"\\]|\\.)*")/u;

/** The title and the id of each element a sentence cites, as the sent text gives them. */
function namesOfCited(sentence: SummarySentence, sent: string): string[] {
  const lines = linesOfKeys(sent);
  return sentence.cites.flatMap((key) => {
    const found = TITLE_AND_ID.exec(lines.get(key) ?? '');
    return found === null ? [] : [found[1], found[2]].flatMap((quoted) => z.string().min(1).array().parse([JSON.parse(quoted ?? '""')].filter((value) => value !== '')));
  });
}

const WORD = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;

/** The words of a text, lower case, a hyphenated word being one word: a name is taken out of a sentence as a run of whole words, whatever the case, and never as part of a longer word. */
const wordsOf = (text: string): string[] => text.toLowerCase().match(WORD) ?? [];

function withoutRun(words: readonly string[], run: readonly string[]): string[] {
  if (run.length === 0) return [...words];
  const left: string[] = [];
  for (let index = 0; index < words.length; ) {
    if (run.every((word, offset) => words[index + offset] === word)) index += run.length;
    else {
      left.push(words[index] ?? '');
      index += 1;
    }
  }
  return left;
}

/**
 * A sentence states a verdict when a word of the list lies outside the titles and ids of the elements it cites: a business called Crimson Trading is a name, "this is fraud" is a verdict. Without the text sent
 * no title is known, and every word counts. The names are taken out as runs of whole words, in any case, longest first.
 */
export function holdsVerdict(sentence: SummarySentence, sent = ''): boolean {
  const names = namesOfCited(sentence, sent).map(wordsOf).sort((left, right) => right.length - left.length);
  const left = names.reduce((words, name) => withoutRun(words, name), wordsOf(sentence.text));
  return OFFENCE.test(left.join(' '));
}

export function expectNoVerdict(sentences: readonly SummarySentence[], sent = ''): void {
  for (const sentence of sentences) if (holdsVerdict(sentence, sent)) fail(`a sentence holds verdict wording: ${sentence.text}`);
}

const TOKEN = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;
const NUMBER = /[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)/gu;

/** The standalone numbers of a text, with a minus sign or a leading point when they have one: a token that holds a letter or an underscore (`AC-1`, `n1`, `123ABC`) is an identifier and holds no number, a date is its year, month and day; thousands separators and a plus sign are dropped. */
function numbersIn(text: string): string[] {
  const plain = text.replace(TOKEN, (token) => (/[\p{L}_]/u.test(token) ? ' ' : token));
  return (plain.match(NUMBER) ?? []).map((token) => token.replaceAll(',', '').replace(/^\+/u, ''));
}

/** The numbers of a sent line, after its key, and the cardinals it writes in words from eleven up, quoted ones included. */
function numbersOfLine(line: string): string[] {
  const after = line.slice(line.indexOf('|') + 1);
  return [...numbersIn(after), ...wordMentionsIn(after, true).filter((found) => Number(found.value) > 10).map((found) => found.value)];
}

/** Words that make a number about something other than the cited elements: the whole source, what was not retrieved or shown, a bound or an approximation. */
const NOT_ABOUT_THE_CITED = /(?<![\p{L}\p{N}_-])(?:in total|total|totals|overall|altogether|in all|source-wide|the (?:whole |entire )?(?:source|database)|not (?:yet )?(?:retrieved|loaded|shown|read|listed|counted)|unretrieved|hidden|remaining|further|additional|beyond|more|fewer|less|over|under|exceeds?|exceeding|at least|at most|up to|about|approximately|around|roughly|nearly|almost)(?![\p{L}\p{N}_-])/iu;

/** The kind and the type a sent line writes after its key: `n3 | "transaction" | …` is an entity, `e1 | "SENT" | …` a relationship. */
const typeOfLine = (key: string, line: string | undefined): string | undefined => {
  const type = /^[ne]\d+ \| "([^"]+)"/u.exec(line ?? '')?.[1];
  return type === undefined ? undefined : `${key.startsWith('n') ? 'entity' : 'relationship'} ${type}`;
};

const escapeText = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The name a type is written with in a sentence: lower case, the underscores and the repeated white space gone. */
const nameOfType = (type: string): string => type.slice(type.indexOf(' ') + 1).toLowerCase().replaceAll('_', ' ').replace(/\s+/gu, ' ').trim();

/** The pattern of a type's name at the start of a text, whole, as the singular or the plural, across any white space or underscore between its words. */
function typeWordPattern(name: string): RegExp {
  const parts = name.split(' ').map(escapeText);
  const last = parts.pop() ?? '';
  const forms = [last, `${last}s`, `${last}es`, ...(last.endsWith('y') ? [`${last.slice(0, -1)}ies`] : [])];
  return new RegExp(`^\\s*${[...parts, `(?:${forms.join('|')})`].join('[\\s_]+')}(?![\\p{L}\\p{N}_-])`, 'iu');
}

/** The titles and ids an element's line writes. */
const namesOfLine = (line: string | undefined): string[] =>
  [...(line ?? '').matchAll(/\b(?:title|id): ("(?:[^"\\]|\\.)*")/gu)].flatMap((found) => {
    const value: unknown = JSON.parse(found[1] ?? '""');
    return typeof value === 'string' && value !== '' ? [value] : [];
  });

const wholeIn = (name: string, text: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeText(name)}(?![\\p{L}\\p{N}_-])`, 'u').test(text);

/** Whether a number is how many of the cited elements are of the type, or of the kind (entities, relationships, elements), the words after it name, less those the sentence names apart from the count, by title or id (the list of names that follows the count is part of it). */
function countsCitedOfType(found: { readonly value: string; readonly after: string }, sentence: SummarySentence, lines: Map<string, string>): boolean {
  if (!/^\d+$/u.test(found.value) || NOT_ABOUT_THE_CITED.test(sentence.text.replace(/\s+/gu, ' '))) return false;
  const cited = [...new Set(sentence.cites)].flatMap((key) => {
    const type = typeOfLine(key, lines.get(key));
    return type === undefined ? [] : [{ key, type }];
  });
  const everyName = [...new Set([...lines.values()].flatMap(namesOfLine).map((name) => name.normalize('NFC')))].sort((first, second) => second.length - first.length);
  const alternatives = everyName.map(escapeText).join('|');
  const nameOf = `(?<![\\p{L}\\p{N}_-])(?:${alternatives})(?![\\p{L}\\p{N}_-])`;
  const between = '(?:[\\s,;&()]|(?<![\\p{L}\\p{N}_-])(?:and|to|through)(?![\\p{L}\\p{N}_-]))+';
  const run = `${nameOf}(?:${between}${nameOf})*`;
  const followingList = everyName.length === 0 ? undefined : new RegExp(`^[\\s,;:(]*${run}`, 'iu');
  const precedingList = everyName.length === 0 ? undefined : new RegExp(`${run}[\\s,;:)]*$`, 'iu');
  const text = sentence.text.normalize('NFC');
  const tail = found.after.normalize('NFC');
  const before = text.slice(0, text.length - tail.length).replace(/\S+$/u, '');
  const candidates = [
    ...[...new Set(cited.map((item) => item.type))].map((type) => ({ name: nameOfType(type), accepts: (held: string) => held === type })),
    { name: 'entity', accepts: (held: string) => held.startsWith('entity ') },
    { name: 'relationship', accepts: (held: string) => held.startsWith('relationship ') },
    { name: 'element', accepts: () => true },
  ];
  return candidates.some((candidate) => {
    const head = typeWordPattern(candidate.name).exec(tail);
    if (head === null) return false;
    const rest = tail.slice(head[0].length);
    const outside = `${before.slice(0, before.length - (precedingList?.exec(before)?.[0].length ?? 0))} ${rest.slice(followingList?.exec(rest)?.[0].length ?? 0)}`;
    const group = cited.filter((item) => candidate.accepts(item.type));
    const namesOf = (key: string): string[] => namesOfLine(lines.get(key)).map((name) => name.normalize('NFC'));
    const counted = group.filter((item) => !namesOf(item.key).some((name) => wholeIn(name, outside) && !group.some((other) => other.key !== item.key && namesOf(other.key).includes(name))));
    return Number(found.value) > 0 && (group.length === Number(found.value) || counted.length === Number(found.value));
  });
}

/** Whether a text opens with the name of a type of the lines sent, or of a kind: a count. */
const opensCount = (after: string, lines: Map<string, string>): boolean =>
  [...new Set([...lines].flatMap(([key, line]) => typeOfLine(key, line) ?? []).map(nameOfType)), 'entity', 'relationship', 'element'].some((name) => typeWordPattern(name).test(after));

/** The numbers of a sentence with the text after each, the words and identifiers blanked to their own length. */
function mentionsIn(text: string): { readonly value: string; readonly after: string }[] {
  const plain = text.replace(TOKEN, (token) => (/[\p{L}_]/u.test(token) ? ' '.repeat(token.length) : token));
  return [...plain.matchAll(NUMBER)].map((found) => ({ value: found[0].replaceAll(',', '').replace(/^\+/u, ''), after: text.slice(found.index + found[0].length) }));
}

const UNIT_WORDS = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TEN_WORDS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');

/** The value of a cardinal written in words, zero to ninety-nine (`twenty-five`), or nothing for any other word. */
function wordValue(word: string): number | undefined {
  const [head = '', unit] = word.toLowerCase().split('-');
  const units = UNIT_WORDS.indexOf(head);
  if (unit === undefined) return units >= 0 ? units : TEN_WORDS.includes(head) ? (TEN_WORDS.indexOf(head) + 2) * 10 : undefined;
  const added = UNIT_WORDS.indexOf(unit);
  return TEN_WORDS.includes(head) && added >= 1 && added <= 9 ? (TEN_WORDS.indexOf(head) + 2) * 10 + added : undefined;
}

/** The cardinals written in words in a text, outside quotes unless asked, with the text after each. */
function wordMentionsIn(text: string, quotedToo = false): { readonly value: string; readonly after: string }[] {
  const outside = quotedToo ? text : text.replace(/"[^"]+"/gu, (quoted) => ' '.repeat(quoted.length));
  return [...outside.matchAll(/(?<![\p{L}\p{N}_-])[a-z]+(?:-[a-z]+)?(?![\p{L}\p{N}_-])/giu)].flatMap((found) => {
    const value = wordValue(found[0]);
    return value === undefined ? [] : [{ value: String(value), after: text.slice(found.index + found[0].length) }];
  });
}

export function numbersUnsupported(sentence: SummarySentence, sent: string): string[] {
  const lines = linesOfKeys(sent);
  const supported = new Set(sentence.cites.flatMap((key) => numbersOfLine(lines.get(key) ?? '')));
  const written = wordMentionsIn(sentence.text).filter((found) => Number(found.value) > 10 || opensCount(found.after, lines));
  return [...mentionsIn(sentence.text), ...written].filter((found) => !supported.has(found.value) && !countsCitedOfType(found, sentence, lines)).map((found) => found.value);
}

export function expectNumbersCited(sentences: readonly SummarySentence[], sent: string): void {
  for (const sentence of sentences) {
    const missing = numbersUnsupported(sentence, sent);
    if (missing.length > 0) fail(`a number is not in the lines the sentence cites: ${missing.join(', ')}`);
  }
}

/** A sentence that states a number beside a count the text gives as not known, or the number of an inexact count without the phrase that labels it; an exact count needs no label. */
export function countRuleBroken(sentence: SummarySentence, sent: string): boolean {
  const lines = linesOfKeys(sent);
  const stated = [...numbersIn(sentence.text), ...wordMentionsIn(sentence.text).filter((found) => Number(found.value) > 10 || opensCount(found.after, lines)).map((found) => found.value)];
  return sentence.cites.some((key) => {
    const members = /\| members: ([^|]+)/u.exec(lines.get(key) ?? '')?.[1]?.trim();
    if (members === undefined) return false;
    if (members === 'not known') return stated.length > 0;
    if (members.endsWith('(exact)')) return false;
    const value = numbersIn(members)[0];
    return value !== undefined && stated.includes(value) && !sentence.text.includes(members);
  });
}

export function expectCountsLabelled(sentences: readonly SummarySentence[], sent: string): void {
  for (const sentence of sentences) if (countRuleBroken(sentence, sent)) fail(`a sentence breaks the rule of a count: ${sentence.text}`);
}

/** No kept sentence holds a name or phrase that no element holds. */
export function expectNoneOf(sentences: readonly SummarySentence[], names: readonly string[]): void {
  for (const sentence of sentences) for (const name of names) if (sentence.text.includes(name)) fail(`a sentence holds ${name}, which no element holds`);
}


function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, entry]) => [key, sorted(entry)]));
  return value;
}

export const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The SHA-256 of a value written as JSON with its keys in order, worked out here and not by the product. */
export const hashOfValue = (value: unknown): string => sha256Of(JSON.stringify(sorted(value)));


const RANK_UP = new Set(['largest', 'biggest', 'greatest', 'highest', 'maximum', 'latest']);
const RANK_DOWN = new Set(['smallest', 'lowest', 'minimum', 'earliest', 'fewest', 'least']);

interface HeldElement {
  readonly type: string;
  readonly names: readonly string[];
  readonly values: ReadonlyMap<string, { readonly raw: unknown; readonly masked: boolean } | undefined>;
}

/** The elements of the sent text with the values of their properties, read from the lines as they are written: `nK | "type" | title: "T" | id: "I" | key: value; key: value (masked)`. */
function heldElementsOf(sent: string): Map<string, HeldElement> {
  const held = new Map<string, HeldElement>();
  for (const line of sent.split('\n')) {
    const found = /^(n\d+) \| "([^"]*)" \| title: ("(?:[^"\\]|\\.)*") \| id: ("(?:[^"\\]|\\.)*")(?: \| (.*))?$/u.exec(line);
    if (found === null) continue;
    const values = new Map<string, { readonly raw: unknown; readonly masked: boolean } | undefined>();
    for (const part of (found[5] ?? '').matchAll(/([\p{L}_][\p{L}\p{N}_]*): (\(not shown\)|"(?:[^"\\]|\\.)*"|[^;]+?)( \(masked\))?(?:; |$)/gu)) {
      values.set(part[1] ?? '', part[2] === '(not shown)' ? undefined : { raw: JSON.parse(part[2] ?? 'null') as unknown, masked: part[3] !== undefined });
    }
    held.set(found[1] ?? '', { type: found[2] ?? '', names: [JSON.parse(found[3] ?? '""') as string, JSON.parse(found[4] ?? '""') as string], values });
  }
  return held;
}

/** A decimal as a whole number scaled by 10^30, so that any two decimals compare as integers: no rounding. */
function scaledDecimal(raw: unknown): bigint | undefined {
  const text = String(raw).trim();
  const found = /^(-?)(\d+)(?:\.(\d{1,30}))?$/u.exec(text);
  if (found === null) return undefined;
  const value = BigInt(`${found[2]}${(found[3] ?? '').padEnd(30, '0')}`);
  return found[1] === '-' ? -value : value;
}

/** A time as a whole number of nanoseconds (an instant), or of days (a calendar day): by the class the fixture declares. */
function timeAsNumber(raw: unknown, dataClass: string): bigint | undefined {
  const text = String(raw);
  if (dataClass === 'date') {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
    return day === null ? undefined : BigInt(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
  }
  const zoned = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(text);
  if (dataClass !== 'dateTime' || zoned === null) return undefined;
  const milliseconds = Date.parse(`${zoned[1]}.000${zoned[3]}`);
  return Number.isNaN(milliseconds) ? undefined : BigInt(milliseconds) * 1_000_000n + BigInt((zoned[2] ?? '').padEnd(9, '0'));
}

/**
 * The suite's own statement of the rule for a ranking sentence, from the sent text and the data class each property declares in the fixture (the sent text does not carry the class). A sentence that says the largest, smallest, latest,
 * earliest, fewest or least must name, right after the word, a property of the elements it cites; every element of the type that carries it must be cited with a shown, unmasked value of an orderable class; the extreme must be held by
 * one element; and the element the sentence names, or the figure it claims, must be that one. Returns whether the sentence breaks the rule.
 */
export function rankingBroken(sentence: SummarySentence, sent: string, classes: ReadonlyMap<string, string>): boolean {
  const tokens = sentence.text.match(/[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu) ?? [];
  const at = tokens.findIndex((token) => RANK_UP.has(token.toLowerCase()) || RANK_DOWN.has(token.toLowerCase()));
  if (at < 0) return false;
  const word = (tokens[at] ?? '').toLowerCase();
  if (tokens.slice(0, at).some((token) => ['not', 'no', 'never'].includes(token.toLowerCase()) || /n't$/iu.test(token))) return true;
  if (tokens.some((token, index) => index > at && (RANK_UP.has(token.toLowerCase()) || RANK_DOWN.has(token.toLowerCase())))) return true;
  const held = heldElementsOf(sent);
  const cited = sentence.cites.filter((key) => held.has(key));
  const property = [...new Set(cited.flatMap((key) => [...(held.get(key)?.values.keys() ?? [])]))].find((key) => key === tokens[at + 1]);
  if (property === undefined) return true;
  const type = defined(cited.map((key) => held.get(key)).find((element) => element?.values.has(property)), 'an element with the property').type;
  const population = [...held].filter(([, element]) => element.type === type);
  const dataClass = classes.get(property);
  if (dataClass === undefined || !['number', 'date', 'dateTime'].includes(dataClass)) return true;
  const numbers = new Map<string, bigint>();
  for (const [key, element] of population) {
    const value = element.values.get(property);
    if (!cited.includes(key) || value === undefined || value.masked) return true;
    const number = dataClass === 'number' ? scaledDecimal(value.raw) : timeAsNumber(value.raw, dataClass);
    if (number === undefined) return true;
    numbers.set(key, number);
  }
  if ((word === 'latest' || word === 'earliest') && dataClass === 'number') return true;
  const up = RANK_UP.has(word);
  const order = [...numbers].sort(([, first], [, second]) => (first === second ? 0 : (first > second) === up ? -1 : 1));
  const [top, next] = order;
  if (top === undefined || (next !== undefined && next[1] === top[1])) return true;
  const named = population.filter(([key, element]) => cited.includes(key) && element.names.some((name) => sentence.text.includes(name)));
  if (named.length > 1 || (named[0] !== undefined && named[0][0] !== top[0])) return true;
  const after = tokens.slice(at + 2).join(' ');
  const figure = dataClass === 'number' ? /-?\d[\d,]*(?:\.\d+)?/u.exec(sentence.text.slice(sentence.text.indexOf(property) + property.length)) : /\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?/u.exec(after);
  if (figure === null) return named.length === 0;
  const claimed = dataClass === 'number' ? scaledDecimal(figure[0].replaceAll(',', '')) : timeAsNumber(figure[0], dataClass === 'date' && figure[0].includes('T') ? 'dateTime' : dataClass);
  return claimed === undefined || claimed !== top[1];
}
