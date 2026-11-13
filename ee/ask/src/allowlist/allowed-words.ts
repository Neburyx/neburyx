import { COMMON_WORDS } from './common-words.js';
import { vocabularyForms } from './forms.js';

/** Every lowercase word the rebuild would accept as a plain word: the forms of the vocabulary and the common words. It only reads; the rebuild does not take it. */
export function allowedWords(vocabulary: readonly string[]): ReadonlySet<string> {
  return new Set([...vocabularyForms(vocabulary), ...COMMON_WORDS]);
}
