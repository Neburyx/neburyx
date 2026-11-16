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

/** The numbers of a sent line, after its key. */
function numbersOfLine(line: string): string[] {
  return numbersIn(line.slice(line.indexOf('|') + 1));
}

export function numbersUnsupported(sentence: SummarySentence, sent: string): string[] {
  const lines = linesOfKeys(sent);
  const supported = new Set(sentence.cites.flatMap((key) => numbersOfLine(lines.get(key) ?? '')));
  return numbersIn(sentence.text).filter((found) => !supported.has(found));
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
  const stated = numbersIn(sentence.text);
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
