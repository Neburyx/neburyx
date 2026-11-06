import { MAX_SEARCH_TEXT_LENGTH, MIN_SEARCH_TEXT_LENGTH } from '@neburyx/contracts';
import { SEARCH_COPY, TOO_LONG } from './copy.js';

const codePoints = (text: string): number => Array.from(text).length;

export function searchTextProblem(text: string): string | undefined {
  if (codePoints(text) < MIN_SEARCH_TEXT_LENGTH) return SEARCH_COPY.tooShort;
  if (codePoints(text) > MAX_SEARCH_TEXT_LENGTH) return TOO_LONG;
  return undefined;
}
