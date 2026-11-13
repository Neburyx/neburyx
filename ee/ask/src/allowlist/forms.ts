const VOWELS = 'aeiou';

function partsOf(entry: string): string[] {
  return entry
    .split(/[-_\s]+/)
    .flatMap((segment) => segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' '))
    .filter((part) => /^[A-Za-z]+$/.test(part))
    .map((part) => part.toLowerCase());
}

const isConsonant = (letter: string): boolean => /^[a-z]$/.test(letter) && !VOWELS.includes(letter);

function endsWithDoublingPattern(word: string): boolean {
  if (word.length < 2) return false;
  const last = word.charAt(word.length - 1);
  if (!isConsonant(last) || 'wxy'.includes(last)) return false;
  if (!VOWELS.includes(word.charAt(word.length - 2))) return false;
  return word.length === 2 || isConsonant(word.charAt(word.length - 3));
}

/**
 * The typed forms that count as a vocabulary word: the word, then `s`, `es`, `d`, `ed` or `ing` added; `y` replaced by `ies` or `ied`;
 * a final `e` replaced by `ing`; and a final consonant after one vowel doubled before `ed` or `ing`. Nothing else (no prefix, `er`, `ly`).
 */
export function formsOf(word: string): readonly string[] {
  const forms = [word, `${word}s`, `${word}es`, `${word}d`, `${word}ed`, `${word}ing`];
  if (word.endsWith('y')) forms.push(`${word.slice(0, -1)}ies`, `${word.slice(0, -1)}ied`);
  if (word.endsWith('e')) forms.push(`${word.slice(0, -1)}ing`);
  if (endsWithDoublingPattern(word)) {
    const doubled = `${word}${word.charAt(word.length - 1)}`;
    forms.push(`${doubled}ed`, `${doubled}ing`);
  }
  return forms;
}

/** Every lowercase typed form of the words of the vocabulary entries. A part with a digit or a non-ASCII character is dropped. */
export function vocabularyForms(entries: readonly string[]): ReadonlySet<string> {
  const forms = new Set<string>();
  for (const word of entries.flatMap(partsOf)) for (const form of formsOf(word)) forms.add(form);
  return forms;
}
