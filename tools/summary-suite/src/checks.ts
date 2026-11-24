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
  // the entities the cited elements are or join: an edge line writes its ends as the keys of the entity lines (`e1 | "TYPE" | n1 -> n2 | …`)
  // an edge line writes its ends as the keys of the entity lines, or, for an end that was not read, as its type and id (`e1 | "TYPE" | n1 -> an end that was not read ("type" "id") | …`)
  const endsOfEdge = (line: string | undefined): { readonly key: string; readonly type: string }[] => {
    const written = /^e\d+ \| "[^"]*" \| (.+?) -> (.+?)(?: \||$)/u.exec(line ?? '')?.slice(1, 3) ?? [];
    return written.flatMap((end) => {
      const unread = /^an end that was not read \(("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")\)$/u.exec(end);
      if (unread !== null) return [{ key: `unread ${unread[1]} ${unread[2]}`, type: `entity ${String(JSON.parse(unread[1] ?? '""'))}` }];
      const type = /^n\d+$/u.test(end) ? typeOfLine(end, lines.get(end)) : undefined;
      return type === undefined ? [] : [{ key: end, type }];
    });
  };
  const ends = [...new Map(cited.flatMap((item) => (item.key.startsWith('n') ? [{ key: item.key, type: item.type }] : endsOfEdge(lines.get(item.key)))).map((item) => [item.key, item] as const)).values()];
  const candidates = [
    ...[...new Set([...cited.map((item) => item.type), ...ends.map((item) => item.type)])].map((type) => ({ name: nameOfType(type), accepts: (held: string) => held === type })),
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
    // the entities of the candidate's kind the cited relationships bring in beyond the cited ones: the ends are then the only population, counted as they are
    const endGroup = candidate.name === 'element' ? [] : ends.filter((item) => candidate.accepts(item.type) && item.type.startsWith('entity '));
    const citedEntities = group.filter((item) => item.type.startsWith('entity '));
    if (endGroup.length > citedEntities.length) return Number(found.value) > 0 && endGroup.length === Number(found.value);
    const namesOf = (key: string): string[] => namesOfLine(lines.get(key)).map((name) => name.normalize('NFC'));
    const counted = group.filter((item) => !namesOf(item.key).some((name) => wholeIn(name, outside) && !group.some((other) => other.key !== item.key && namesOf(other.key).includes(name))));
    return Number(found.value) > 0 && (group.length === Number(found.value) || counted.length === Number(found.value));
  });
}

/** `no two widgets share an owner`: the number is a pair of the set, not a count of what is cited. */
const PAIRWISE = /(?<![\p{L}\p{N}_-])(?:no|any)\s+$/iu;

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
function wordMentionsIn(text: string, quotedToo = false): { readonly value: string; readonly after: string; readonly before: string }[] {
  const outside = quotedToo ? text : text.replace(/"[^"]+"/gu, (quoted) => ' '.repeat(quoted.length));
  return [...outside.matchAll(/(?<![\p{L}\p{N}_-])[a-z]+(?:-[a-z]+)?(?![\p{L}\p{N}_-])/giu)].flatMap((found) => {
    const value = wordValue(found[0]);
    return value === undefined ? [] : [{ value: String(value), after: text.slice(found.index + found[0].length), before: text.slice(0, found.index) }];
  });
}

/** The ways an instant may be written in part, each an exact part of the line's instant (the date, the time of day with or without its zone, hours and minutes when the seconds are nothing). */
function instantParts(instant: string): string[] {
  const at = instant.indexOf('T');
  const date = instant.slice(0, at);
  const time = instant.slice(at + 1);
  const bare = time.replace(/(Z|[+-]\d\d:\d\d)$/u, '');
  const parts = [instant, date, time, bare];
  if (!bare.includes('.') && bare.endsWith(':00')) parts.push(bare.slice(0, 5), `${bare.slice(0, 5)}${time.slice(bare.length)}`);
  return parts;
}

/** The sentence with each date or time it writes as an exact part of an instant of the cited lines taken out: those are judged with the instant, and are no numbers to find on a line. */
function withoutInstantParts(text: string, cited: readonly string[]): string {
  const parts = new Set(cited.flatMap((line) => line.match(/\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)?/gu) ?? []).flatMap(instantParts));
  return text.replace(/\d{4}-\d\d-\d\d(?:T[\d:.]+(?:Z|[+-]\d\d:\d\d)?)?|(?<![\d:])\d{1,2}:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?(?![\d:])/gu, (found) => (parts.has(found) ? ' '.repeat(found.length) : found));
}

export function numbersUnsupported(sentence: SummarySentence, sent: string): string[] {
  const lines = linesOfKeys(sent);
  const supported = new Set(sentence.cites.flatMap((key) => numbersOfLine(lines.get(key) ?? '')));
  const text = withoutInstantParts(sentence.text, sentence.cites.map((key) => lines.get(key) ?? ''));
  const written = wordMentionsIn(sentence.text).filter((found) => Number(found.value) > 10 || (opensCount(found.after, lines) && !PAIRWISE.test(found.before)));
  return [...mentionsIn(text), ...written].filter((found) => !supported.has(found.value) && !countsCitedOfType(found, sentence, lines)).map((found) => found.value);
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
  const stated = [...numbersIn(sentence.text), ...wordMentionsIn(sentence.text).filter((found) => Number(found.value) > 10 || (opensCount(found.after, lines) && !PAIRWISE.test(found.before))).map((found) => found.value)];
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

/** The elements a ranking sentence names in a list after `of`, `among` or `between` (two or more, all cited, of one type), and the sentence without that list: the set the sentence ranks, when it names it in full. */
function enumeratedSet(text: string, held: ReadonlyMap<string, HeldElement>, cited: readonly string[]): { readonly keys: readonly string[]; readonly outside: string } | undefined {
  const names = [...held.values()].flatMap((element) => element.names).filter((name) => name !== '').sort((first, second) => second.length - first.length);
  if (names.length === 0) return undefined;
  const one = `(?<![\\p{L}\\p{N}_-])(?:${names.map(escapeText).join('|')})(?![\\p{L}\\p{N}_-])`;
  const found = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:of|among|amongst|between|out of)\\s+(?:(?:the|these|those)\\s+)?(?:[\\p{L}\\p{N}_-]+\\s+){0,2}?(${one}(?:(?:[\\s,;&()]|(?<![\\p{L}\\p{N}_-])(?:and|to|through)(?![\\p{L}\\p{N}_-]))+${one})+)`, 'iu').exec(text);
  const whole = found?.[1];
  if (found === null || whole === undefined) return undefined;
  // a list names each element once: a name that comes again is the subject of what follows, not a member
  const seen = new Set<string>();
  const repeat = [...whole.matchAll(new RegExp(one, 'giu'))].find((mention) => seen.size === seen.add(mention[0].toLowerCase()).size);
  const list = repeat === undefined ? whole : whole.slice(0, repeat.index).replace(/[\s,;&()]*(?:(?:and|to|through)\s*)?$/iu, '');
  const first = found.index + found[0].length - whole.length;
  // the list stands at the ranking word: a few words from it in the same stretch of the sentence, before or after
  const unnamed = text.replace(new RegExp(one, 'giu'), (mention) => ' '.repeat(mention.length));
  const between = (from: number, to: number): number | undefined => (/[.;:!?]/u.test(unnamed.slice(from, to)) || /(?<![\p{L}\p{N}_-])(?:and|but|while|whereas|or)(?![\p{L}\p{N}_-])/iu.test(unnamed.slice(from, to)) ? undefined : (unnamed.slice(from, to).match(/[\p{L}\p{N}_-]+/gu) ?? []).length);
  const listEnd = first + list.length;
  const widening = /(?<![\p{L}\p{N}_-])(?:and|or|as|also|too|plus|elsewhere|rest|others|remaining|than|more|whole|entire|everywhere|any|all|every|each|throughout|including|of|among|across|within|in|from)(?![\p{L}\p{N}_-])/iu;
  const attached = [...unnamed.matchAll(/[\p{L}\p{N}_-]+/gu)].filter((word) => RANK_UP.has(word[0].toLowerCase().split('-')[0] ?? '') || RANK_DOWN.has(word[0].toLowerCase().split('-')[0] ?? '')).some((word) => {
    const after = between(word.index + word[0].length, found.index);
    const before = between(listEnd, word.index);
    // after the ranking word the list must be closed (a clause end, the figure, or the holder's verb); opening the sentence it is closed by a comma and nothing after the ranking opens another set
    const widensAfterList = widening.test(unnamed.slice(first + list.length));
    return (word.index + word[0].length <= found.index && after !== undefined && after <= 3 && /^\s*(?:$|[,.;]|[-+]?\d|(?:is|are|was|were|has|have|had|belongs|goes)(?![\p{L}\p{N}_-]))/iu.test(unnamed.slice(first + list.length)) && !widensAfterList) || (word.index >= listEnd && before !== undefined && before <= 5 && text.slice(0, found.index).trim() === '' && /^\s*,/u.test(text.slice(listEnd)) && !widening.test(unnamed.slice(listEnd)));
  });
  if (!attached) return undefined;
  const keys = cited.filter((key) => held.get(key)?.names.some((name) => name !== '' && list.includes(name)));
  const types = new Set(keys.map((key) => held.get(key)?.type));
  if (keys.length < 2 || types.size !== 1) return undefined;
  const mentions = [...list.matchAll(new RegExp(one, 'giu'))].map((mention) => mention[0]);
  if (!mentions.every((mention) => keys.some((key) => held.get(key)?.names.includes(mention) === true))) return undefined;
  return { keys, outside: `${text.slice(0, first)}${' '.repeat(list.length)}${text.slice(first + list.length)}` };
}

/**
 * The suite's own statement of the rule for a ranking sentence, from the sent text and the data class each property declares in the fixture (the sent text does not carry the class). A sentence that says the largest, smallest, latest,
 * earliest, fewest or least must name, right after the word, a property of the elements it cites; every element of the type that carries it must be cited with a shown, unmasked value of an orderable class; the extreme must be held by
 * one element; and the element the sentence names, or the figure it claims, must be that one. Returns whether the sentence breaks the rule.
 */
export function rankingBroken(sentence: SummarySentence, sent: string, classes: ReadonlyMap<string, string>): boolean {
  const tokens = sentence.text.match(/[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu) ?? [];
  // a ranking word joined to another by a hyphen (`highest-value`) is the ranking word
  const head = (token: string): string => token.toLowerCase().split('-')[0] ?? '';
  const at = tokens.findIndex((token) => RANK_UP.has(head(token)) || RANK_DOWN.has(head(token)));
  if (at < 0) return false;
  const word = head(tokens[at] ?? '');
  const held = heldElementsOf(sent);
  const keysOfCited = [...new Set(sentence.cites.flatMap((key) => [...(held.get(key)?.values.keys() ?? [])]))];
  // a property whose key begins with the ranking word and is written out after it is named, not ranked; `a maximum of` is a quantity
  const rest = tokens.slice(at + 1).join('').toLowerCase();
  if (keysOfCited.some((key) => key.toLowerCase().startsWith(word) && key.length > word.length && rest.startsWith(key.toLowerCase().slice(word.length)))) return false;
  if (/(?:^|\s)an?\s*$/iu.test(sentence.text.slice(0, sentence.text.toLowerCase().indexOf(word)))) return false;
  if (tokens.slice(0, at).some((token) => ['not', 'no', 'never'].includes(token.toLowerCase()) || /n't$/iu.test(token))) return true;
  const namedAfter = (index: number): boolean => keysOfCited.some((key) => key.toLowerCase().startsWith((tokens[index] ?? '').toLowerCase()) && key.toLowerCase().slice((tokens[index] ?? '').length) === tokens.slice(index + 1, index + 1 + 3).join('').toLowerCase().slice(0, key.length - (tokens[index] ?? '').length));
  if (tokens.some((token, index) => index > at && (RANK_UP.has(token.toLowerCase()) || RANK_DOWN.has(token.toLowerCase())) && !namedAfter(index))) return true;
  const cited = sentence.cites.filter((key) => held.has(key));
  const propertyKeys = [...new Set(cited.flatMap((key) => [...(held.get(key)?.values.keys() ?? [])]))];
  const after = propertyKeys.find((key) => [1, 2, 3, 4].some((count) => tokens.slice(at + 1, at + 1 + count).join('').toLowerCase() === key.toLowerCase()));
  // a property written whole before the ranking word (`has amount 12, the largest of them`) is the one ranked, when it is the only one written there
  const writtenBefore = propertyKeys.flatMap((key) => [1, 2, 3, 4].flatMap((count) => tokens.slice(0, at).flatMap((_token, index) => (index + count <= at && tokens.slice(index, index + count).join('').toLowerCase() === key.toLowerCase() ? [{ key, end: index + count - 1 }] : []))));
  const before = new Set(writtenBefore.map((entry) => entry.key)).size === 1 ? writtenBefore[writtenBefore.length - 1] : undefined;
  const property = after ?? before?.key;
  if (property === undefined) return true;
  const count = [1, 2, 3, 4].find((length) => tokens.slice(at + 1, at + 1 + length).join('').toLowerCase() === property.toLowerCase()) ?? 1;
  const last = (tokens[at + count] ?? '').toLowerCase();
  const lastBefore = (tokens[before?.end ?? 0] ?? '').toLowerCase();
  const afterProperty = after === undefined ? sentence.text.toLowerCase().indexOf(lastBefore) + lastBefore.length : sentence.text.toLowerCase().indexOf(last, sentence.text.toLowerCase().indexOf(word)) + last.length;
  const type = defined(cited.map((key) => held.get(key)).find((element) => element?.values.has(property)), 'an element with the property').type;
  const listed = enumeratedSet(sentence.text, held, cited);
  const population = [...held].filter(([key, element]) => element.type === type && (listed === undefined || listed.keys.includes(key)));
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
  const outside = listed?.outside ?? sentence.text;
  const named = population.filter(([key, element]) => cited.includes(key) && element.names.some((name) => outside.includes(name)));
  if (named.length > 1 || (named[0] !== undefined && named[0][0] !== top[0])) return true;
  const afterText = after === undefined ? sentence.text.slice(afterProperty) : tokens.slice(at + 2).join(' ');
  const figure = dataClass === 'number' ? /-?\d[\d,]*(?:\.\d+)?/u.exec(sentence.text.slice(afterProperty)) : /\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?/u.exec(afterText);
  if (figure === null) return named.length === 0;
  const claimed = dataClass === 'number' ? scaledDecimal(figure[0].replaceAll(',', '')) : timeAsNumber(figure[0], dataClass === 'date' && figure[0].includes('T') ? 'dateTime' : dataClass);
  return claimed === undefined || claimed !== top[1];
}


const RANGE_OF = /(?:between|from)\s+["“]?([-+]?\d[^"”\s]*)["”]?\s+(?:and|to)\s+["“]?([-+]?\d[^"”\s]*?)["”]?(?:\.(?:\s|$)|[\s,;]|$)/iu;

/**
 * The suite's own statement of the rule for a range (`between A and B`, `from A to B`) over a property of a set: the sentence names a property of the cited elements, every element of that type is cited with a value of it, A is the least value
 * among them and B the greatest, each as written on the line of an element that holds it (a time of day as an exact part of the instant). Returns whether the sentence breaks the rule.
 */
export function rangeBroken(sentence: SummarySentence, sent: string, classes: ReadonlyMap<string, string>): boolean {
  const found = RANGE_OF.exec(sentence.text);
  if (found === null) return false;
  const held = heldElementsOf(sent);
  const cited = sentence.cites.filter((key) => held.has(key));
  const words = new Set((sentence.text.replace(found[0], ' ').match(/[\p{L}\p{N}_]+/gu) ?? []).map((word) => word.toLowerCase().replace(/s$/u, '')));
  const pairs = [...new Map(cited.flatMap((key) => [...(held.get(key)?.values.keys() ?? [])].map((property) => [`${held.get(key)?.type}\u0000${property}`, { type: held.get(key)?.type ?? '', property }] as const)))].map(([, pair]) => pair);
  const isDay = (literal: string): boolean => /^\d{4}-\d\d-\d\d$/u.test(literal);
  const isTime = (literal: string): boolean => /^\d{4}-\d\d-\d\d|^\d{1,2}:\d\d/u.test(literal);
  // the ends are both dates or times, or both figures
  if (isTime(found[1] ?? '') !== isTime(found[2] ?? '')) return false;
  const ofTime = isTime(found[1] ?? '');
  const fitting = pairs.filter((pair) => {
    const kind = classes.get(pair.property) ?? '';
    return ofTime ? ['date', 'dateTime'].includes(kind) && (kind !== 'date' || (isDay(found[1] ?? '') && isDay(found[2] ?? ''))) : kind === 'number';
  });
  const keys = [...new Set(fitting.map((pair) => pair.property))].filter((key) => words.has(key.toLowerCase()));
  if (keys.length > 1) return true;
  const tokens = new Set((sentence.text.replace(found[0], ' ').match(/[\p{L}\p{N}_]+/gu) ?? []).map((word) => word.toLowerCase()));
  const plural = (type: string): boolean => [`${type}s`, `${type}es`, `${type.replace(/y$/u, '')}ies`].some((form) => tokens.has(form));
  // figures that name no property: a range over a set only when a cited type is named by its plural noun
  const needsPlural = keys.length === 0 && !ofTime;
  const named = (type: string): boolean => (needsPlural ? plural(type.toLowerCase()) : words.has(type.toLowerCase()));
  if (needsPlural && !fitting.some((pair) => named(pair.type))) return false;
  let candidates = fitting.filter((pair) => keys.length === 0 || pair.property === keys[0]);
  const namedTypes = new Set(candidates.filter((pair) => named(pair.type)).map((pair) => pair.type));
  if (namedTypes.size > 1) return true;
  if (namedTypes.size > 0) candidates = candidates.filter((pair) => namedTypes.has(pair.type));
  if (candidates.length === 0) return keys.length > 0;
  /** Whether the range is broken over one property of one type. */
  const brokenFor = (type: string, property: string): boolean => {
    const dataClass = classes.get(property);
    if (dataClass !== 'dateTime' && dataClass !== 'date' && dataClass !== 'number') return true;
    const numbers = new Map<string, bigint>();
    for (const [key, element] of [...held].filter(([, candidate]) => candidate.type === type)) {
      const value = element.values.get(property);
      if (!cited.includes(key) || value === undefined || value.masked) return true;
      const number = dataClass === 'number' ? scaledDecimal(value.raw) : timeAsNumber(value.raw, dataClass);
      if (number === undefined) return true;
      numbers.set(key, number);
    }
    const low = [...numbers.values()].reduce((best, next) => (next < best ? next : best));
    const high = [...numbers.values()].reduce((best, next) => (next > best ? next : best));
    const holds = (literal: string, end: bigint): boolean =>
      [...numbers].filter(([, number]) => number === end).some(([key]) => {
        const raw = String(held.get(key)?.values.get(property)?.raw);
        return dataClass === 'number' ? scaledDecimal(literal.replaceAll(',', '')) === end : instantParts(raw.includes('T') ? raw : `${raw}T00:00:00`).includes(literal) && (dataClass === 'dateTime' || literal === raw);
      });
    if (!holds(found[1] ?? '', low) || !holds(found[2] ?? '', high)) return true;
    // an end that is a time of day says the whole set lies in a window of one day
    if (dataClass !== 'number' && (!/^\d{4}-/u.test(found[1] ?? '') || !/^\d{4}-/u.test(found[2] ?? ''))) return new Set([...held].filter(([, candidate]) => candidate.type === type).map(([, candidate]) => String(candidate.values.get(property)?.raw).slice(0, 10))).size !== 1;
    return false;
  };
  const candidateTypes = new Set(candidates.map((pair) => pair.type));
  // no type is named and more than one could be what the range is over: it holds only when every one of them with its whole set cited has a property that verifies it; a type cited in part is context
  if (candidateTypes.size > 1) {
    const whole = [...candidateTypes].filter((type) => [...held].filter(([, candidate]) => candidate.type === type).every(([key]) => cited.includes(key)));
    return whole.length === 0 || whole.some((type) => candidates.filter((pair) => pair.type === type).every((pair) => brokenFor(pair.type, pair.property)));
  }
  return candidates.every((pair) => brokenFor(pair.type, pair.property));
}
