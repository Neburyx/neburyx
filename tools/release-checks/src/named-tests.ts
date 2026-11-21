/** One row of a suite's table of named tests: the file (relative to the suite's folder) and the words of a test's title; the safety suite's table also names the guarantee and the kind of proof. */
export interface NamedRow {
  readonly file: string;
  readonly title: string;
  readonly guarantee?: string;
  readonly kind?: string;
}

const FIVE_COLUMNS = /^\| .* \| ([^|`]+) \| ([^|`]+) \| `([^`]+)` \| (.+) \|$/;
const THREE_COLUMNS = /^\| .* \| `([^`]+)` \| (.+) \|$/;

/** The rows of a README's table of named tests, in either form: the file and the test are the last two columns, with a guarantee and a kind before them in the safety suite's. */
export function parseNamedTests(markdown: string): readonly NamedRow[] {
  const section = markdown.includes('## Named tests') ? markdown.slice(markdown.indexOf('## Named tests')) : markdown;
  return section.split('\n').flatMap((line): NamedRow[] => {
    const five = FIVE_COLUMNS.exec(line);
    if (five?.[1] !== undefined && five[2] !== undefined && five[3] !== undefined && five[4] !== undefined) return [{ guarantee: five[1].trim(), kind: five[2].trim(), file: five[3], title: five[4] }];
    const three = THREE_COLUMNS.exec(line);
    return three?.[1] !== undefined && three[2] !== undefined ? [{ file: three[1], title: three[2] }] : [];
  });
}

/** The words of a row as a pattern: found inside a title, with `%s`, `%d` and `%i` standing for any text, as the words are taken from the middle of titles and from `it.each` titles. */
export function wordsPattern(words: string): RegExp {
  const parts = words.split(/%[sdi]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(parts.join('.*'));
}
