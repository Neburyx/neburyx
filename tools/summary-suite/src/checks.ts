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
  return [...numbersIn(after), ...wordMentionsIn(after, true).map((found) => found.value)];
}

/** Words that make a number about something other than the cited elements: the whole source, what was not retrieved or shown, a bound or an approximation. */
const NOT_ABOUT_THE_CITED = /(?<![\p{L}\p{N}_-])(?:in total|total|totals|overall|altogether|in all|source-wide|the (?:whole |entire )?(?:source|database)|not (?:yet )?(?:retrieved|loaded|shown|read|listed|counted)|unretrieved|hidden|remaining|further|additional|beyond|more|fewer|less|over|under|exceeds?|exceeding|at least|at most|up to|about|approximately|around|roughly|nearly|almost)(?![\p{L}\p{N}_-])/iu;

/** The kind and the type a sent line writes after its key: `n3 | "transaction" | …` is an entity, `e1 | "SENT" | …` a relationship. */
const typeOfLine = (key: string, line: string | undefined): string | undefined => {
  const type = /^[ne]\d+ \| "([^"]+)"/u.exec(line ?? '')?.[1];
  return type === undefined ? undefined : `${key.startsWith('n') ? 'entity' : 'relationship'} ${type}`;
};

const formsOf = (name: string): string[] => [name, `${name}s`, `${name}es`, ...(name.endsWith('y') ? [`${name.slice(0, -1)}ies`] : [])];

/** Whether a number is how many of the cited elements are of the type, or of the kind (entities, relationships, elements), the words after it name, said of those elements alone. */
function countsCitedOfType(found: { readonly value: string; readonly after: string }, sentence: SummarySentence, lines: Map<string, string>): boolean {
  if (!/^\d+$/u.test(found.value) || NOT_ABOUT_THE_CITED.test(sentence.text.replace(/\s+/gu, ' '))) return false;
  const named = found.after.toLowerCase().replaceAll('_', ' ').replace(/\s+/gu, ' ').trimStart();
  const types = new Map<string, number>();
  const kinds = new Map<string, number>();
  for (const key of new Set(sentence.cites)) {
    const type = typeOfLine(key, lines.get(key));
    if (type === undefined) continue;
    types.set(type, (types.get(type) ?? 0) + 1);
    for (const kind of ['element', type.slice(0, type.indexOf(' '))]) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const namedAs = (name: string): boolean => formsOf(name).some((form) => named.startsWith(form) && !/^[\p{L}\p{N}_-]/u.test(named.slice(form.length)));
  const wanted = Number(found.value);
  return [...types].some(([type, count]) => count === wanted && namedAs(type.slice(type.indexOf(' ') + 1).toLowerCase().replaceAll('_', ' ').replace(/\s+/gu, ' ').trim())) || [...kinds].some(([kind, count]) => count === wanted && namedAs(kind));
}

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

/** The cardinals written in words from eleven up in a text, outside quotes, with the text after each; the words up to ten are ordinary words of a sentence. */
function wordMentionsIn(text: string, quotedToo = false): { readonly value: string; readonly after: string }[] {
  const outside = quotedToo ? text : text.replace(/"[^"]+"/gu, (quoted) => ' '.repeat(quoted.length));
  return [...outside.matchAll(/(?<![\p{L}\p{N}_-])[a-z]+(?:-[a-z]+)?(?![\p{L}\p{N}_-])/giu)].flatMap((found) => {
    const value = wordValue(found[0]);
    return value === undefined || value <= 10 ? [] : [{ value: String(value), after: text.slice(found.index + found[0].length) }];
  });
}

export function numbersUnsupported(sentence: SummarySentence, sent: string): string[] {
  const lines = linesOfKeys(sent);
  const supported = new Set(sentence.cites.flatMap((key) => numbersOfLine(lines.get(key) ?? '')));
  return [...mentionsIn(sentence.text), ...wordMentionsIn(sentence.text)].filter((found) => !supported.has(found.value) && !countsCitedOfType(found, sentence, lines)).map((found) => found.value);
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
  const stated = [...numbersIn(sentence.text), ...wordMentionsIn(sentence.text).map((found) => found.value)];
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
