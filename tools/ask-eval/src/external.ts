import { isAbsolute, relative, resolve } from 'node:path';
import type { Question } from './questions.js';

export class ExternalFileError extends Error {}

/** The folder that holds `tools/` and `services/`: the checkout. */
export const CHECKOUT_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const DEMO_QUESTIONS = resolve(CHECKOUT_ROOT, 'services', 'api', 'tests', 'ask', 'questions.yaml');

export function isInsideCheckout(path: string): boolean {
  const from = relative(CHECKOUT_ROOT, resolve(path));
  return from === '' || (!from.startsWith('..') && !isAbsolute(from));
}

export function isDemoFile(path: string): boolean {
  return resolve(path) === DEMO_QUESTIONS;
}

/** What a run of a question file outside the checkout must satisfy before it reads anything. */
export function checkExternalRun(options: { readonly questions: string; readonly out: string | undefined; readonly writes: boolean; readonly maxMisses: string | undefined; readonly packs: string | undefined; readonly mapping: string | undefined; readonly refusalTarget: string | undefined }): void {
  if (isDemoFile(options.questions)) return;
  if (isInsideCheckout(options.questions)) throw new ExternalFileError('a question file inside the checkout other than the demo file is refused');
  if (options.packs !== undefined || options.mapping === undefined) throw new ExternalFileError('an external question file takes one --mapping and no --packs');
  if (options.maxMisses === undefined || options.refusalTarget !== 'exact') throw new ExternalFileError('an external question file needs --refusal-target exact and --max-misses <n>');
  if (options.writes) {
    if (options.out === undefined) throw new ExternalFileError('a write for an external question file needs --out <path outside the checkout>');
    if (isInsideCheckout(options.out)) throw new ExternalFileError('--out lies inside the checkout');
  }
}

export function checkOnePack(questions: readonly Question[]): void {
  if (new Set(questions.map((question) => question.pack)).size > 1) throw new ExternalFileError('an external question file names one pack');
}
