import { PATTERN_PROBLEM_CODES, PATTERN_UNAVAILABLE_CODES } from '@neburyx/contracts';
import { FAILURE_CODES_WITH_WORDS } from '../failure-words.js';

const wordOf = (code: string): RegExp => new RegExp(`(?<![A-Za-z0-9_-])${code}(?![A-Za-z0-9_-])`);

/** Codes of the server and of the client in capitals (`RATE_LIMITED`), and the pattern codes of two or more words (`too-many`); a pattern code of one plain word (`missing`) is an ordinary word of the text and is not looked for. */
const LOOKED_FOR: ReadonlyArray<{ readonly code: string; readonly found: RegExp }> = [
  ...FAILURE_CODES_WITH_WORDS.map((code) => ({ code, found: wordOf(code) })),
  ...[...PATTERN_PROBLEM_CODES, ...PATTERN_UNAVAILABLE_CODES].filter((code) => code.includes('-')).map((code) => ({ code, found: new RegExp(wordOf(code).source, 'i') })),
];

/** The failure and pattern codes that `text` shows, each once. */
export const codesIn = (text: string): string[] => [...new Set(LOOKED_FOR.filter(({ found }) => found.test(text)).map(({ code }) => code))];

/** Fails, naming the codes, when `text` shows any: each lane scans the text of its own views with it. */
export function assertNoCodes(text: string, where = 'the text'): void {
  const found = codesIn(text);
  if (found.length > 0) throw new Error(`${where} shows ${found.join(', ')}`);
}
