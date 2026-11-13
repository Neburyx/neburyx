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
 * The typed forms that count as a vocabulary word: the word, then `s`, `ed` or `ing` added, `es` only after `s`, `x`, `z`, `ch`, `sh` or `o`, `d` only after `e`; `y` replaced by `ies` or `ied`;
 * a final `e` replaced by `ing`; and a final consonant after one vowel doubled before `ed` or `ing`. Nothing else (no prefix, `er`, `ly`).
 */
export function formsOf(word: string): readonly string[] {
  const forms = [word, `${word}s`, `${word}ed`, `${word}ing`];
  if (/(s|x|z|ch|sh|o)$/.test(word)) forms.push(`${word}es`);
  if (word.endsWith('e')) forms.push(`${word}d`);
  if (word.endsWith('y')) forms.push(`${word.slice(0, -1)}ies`, `${word.slice(0, -1)}ied`);
  if (word.endsWith('e')) forms.push(`${word.slice(0, -1)}ing`);
  if (endsWithDoublingPattern(word)) {
    const doubled = `${word}${word.charAt(word.length - 1)}`;
    forms.push(`${doubled}ed`, `${doubled}ing`);
  }
  return forms;
}

const IRREGULAR_VERBS: readonly (readonly [string, ...string[]])[] = [
  ['begin', 'began', 'begun'],
  ['bring', 'brought'],
  ['build', 'built'],
  ['buy', 'bought'],
  ['come', 'came'],
  ['draw', 'drew', 'drawn'],
  ['find', 'found'],
  ['give', 'gave', 'given'],
  ['go', 'went', 'gone'],
  ['hold', 'held'],
  ['keep', 'kept'],
  ['know', 'knew', 'known'],
  ['leave', 'left'],
  ['lose', 'lost'],
  ['meet', 'met'],
  ['pay', 'paid'],
  ['run', 'ran'],
  ['see', 'saw', 'seen'],
  ['sell', 'sold'],
  ['send', 'sent'],
  ['spend', 'spent'],
  ['take', 'took', 'taken'],
  ['tell', 'told'],
  ['withdraw', 'withdrew', 'withdrawn'],
  ['write', 'wrote', 'written'],
];

/** The closed list of irregular English verbs: base, then its past and participle forms. */
export const IRREGULAR_VERB_LIST = IRREGULAR_VERBS;

const IRREGULAR_BY_FORM: ReadonlyMap<string, readonly string[]> = new Map(IRREGULAR_VERBS.flatMap((verb) => verb.map((form) => [form, verb] as const)));

const MIN_BASE_LENGTH = 3;

const isVowel = (letter: string): boolean => letter !== '' && VOWELS.includes(letter);

const vowelGroups = (word: string): number => (word.match(/[aeiou]+/g) ?? []).length;

/**
 * The candidate bases of the stem S of an `ed` or `ing` form: exactly one of five rows applies, in this order.
 * 1. A doubled final consonant (not `l`, `s`, `f`, `z`) is undone.
 * 2. S ends in `v`, `rg`, `rc` or `nc`: S + `e` only.
 * 3. A vowel or special ending: `u` gives S + `e`; `e` gives S + `e` under `ed` and S under `ing`; `o` gives S; `i` gives none (the `ied` case covers it);
 *    `iat`/`uat` give S + `e`; `oat` gives S; a vowel pair + `s` or `z` gives S + `e`; `qu` + a vowel + a consonant gives S + `e`.
 *    Limits: `biased` gives `biase`, `conquered` gives `conquere`, `skiing` gives no `ski`.
 * 4. One consonant (not `w`, `x`, `y`) after one single vowel: S + `e` only when S has one vowel group (a short stem such as `fil` or `nam` is the base with an `e`; limit: `owed` gives no `owe`, because a stem in `w` is excluded and `ow` is under 3 letters; because English doubles the consonant of a short stem: `filed` is `file`, `named` is `name`); both S and S + `e` when S has two or more vowel groups (`open`, `limit`).
 *    `ng` with one vowel group: S for `i` or `o` (`bring`, `sing`, `long`), S + `e` otherwise (`change`, `range`; limit: `hanging` gives `hange` and `banging` gives `bange`, both surnames of the public list, and no `hang` or `bang`; `hinging`, `cringing` and `sponging` give no `hinge`, `cringe` or `sponge`);
 *    `ng` with two or more vowel groups, and `eat`, give both S and S + `e`.
 * 5. Otherwise S.
 */
function stemBases(stem: string, suffix: 'ed' | 'ing'): string[] {
  const last = stem.charAt(stem.length - 1);
  const before = stem.charAt(stem.length - 2);
  const third = stem.charAt(stem.length - 3);
  if (stem.length >= 2 && last === before && isConsonant(last) && !'lsfz'.includes(last)) return [stem.slice(0, -1)];
  if (['v', 'rg', 'rc', 'nc'].some((ending) => stem.endsWith(ending))) return [`${stem}e`];
  if (last === 'u') return [`${stem}e`];
  if (last === 'e') return suffix === 'ed' ? [`${stem}e`] : [stem];
  if (last === 'o') return [stem];
  if (last === 'i') return [];
  if (stem.endsWith('iat') || stem.endsWith('uat')) return [`${stem}e`];
  if (stem.endsWith('oat')) return [stem];
  if ((last === 's' || last === 'z') && isVowel(before) && isVowel(third)) return [`${stem}e`];
  if (/qu[aeiou][^aeiou]$/.test(stem)) return [`${stem}e`];
  if (isConsonant(last) && !'wxy'.includes(last) && isVowel(before) && !isVowel(third)) return vowelGroups(stem) >= 2 ? [stem, `${stem}e`] : [`${stem}e`];
  if (stem.endsWith('ng') && vowelGroups(stem) === 1) return /[io]ng$/.test(stem) ? [stem] : [`${stem}e`];
  if (stem.endsWith('ng') || stem.endsWith('eat')) return [stem, `${stem}e`];
  return [stem];
}

/** The candidate bases of one vocabulary part: the words of which the part is a form by the suffix rule, in one step. The part itself is one. */
function candidateBases(part: string): string[] {
  const found = new Set<string>([part]);
  if (part.endsWith('ies') || part.endsWith('ied')) found.add(`${part.slice(0, -3)}y`);
  // a plural in `xes`, `shes` or `oes` is the `es` base only (`boxes` gives `box`, `goes` gives `go` and never `goe`; limit: `toes` and `shoes` give no `toe` or `shoe`); a plural in `ies` is the `y` base; its plain-`s` base is taken only when the `y` base would be shorter than 3 letters (ties, lies, dies)
  if (part.endsWith('s') && !part.endsWith('ss') && !(part.endsWith('ies') && part.length - 3 + 1 >= MIN_BASE_LENGTH) && !/(x|sh|o)es$/.test(part)) found.add(part.slice(0, -1));
  if (/(s|x|z|ch|sh|o)es$/.test(part)) found.add(part.slice(0, -2));
  if (part.endsWith('ed')) for (const base of stemBases(part.slice(0, -2), 'ed')) found.add(base);
  if (part.endsWith('ing')) for (const base of stemBases(part.slice(0, -3), 'ing')) found.add(base);
  return [...found].filter((base) => base.length >= MIN_BASE_LENGTH || base === part);
}

/** Every lowercase typed form of the words of the vocabulary entries. A part with a digit or a non-ASCII character is dropped. */
export function vocabularyForms(entries: readonly string[]): ReadonlySet<string> {
  const forms = new Set<string>();
  for (const part of entries.flatMap(partsOf)) {
    const bases = candidateBases(part);
    for (const base of bases) for (const form of formsOf(base)) forms.add(form);
    for (const word of [part, ...bases]) {
      const verb = IRREGULAR_BY_FORM.get(word);
      if (verb === undefined) continue;
      for (const form of formsOf(verb[0])) forms.add(form);
      for (const form of verb.slice(1)) forms.add(form);
    }
  }
  return forms;
}
