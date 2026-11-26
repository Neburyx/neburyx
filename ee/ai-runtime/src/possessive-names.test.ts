import { describe, expect, it } from 'vitest';
import { removalNoteOf } from './removed-sentences.js';
import { judgeSentences, type CheckedText } from './reply-checks.js';

describe.each([
  { name: 'transfers', holder: 'account', owner: 'customer', paid: 'PAID', owns: 'OWNS' },
  { name: 'filings', holder: 'policy', owner: 'claimant', paid: 'MOVED_TO', owns: 'UNDER' },
])('a named element tied to others by a possessive, in the words of the $name mapping', ({ holder, owner, paid, owns }) => {
  const holders = holder.endsWith('y') ? `${holder.slice(0, -1)}ies` : `${holder}s`;
  const entities = [
    ['o1', owner, 'Gamma Partners'], ['o2', owner, 'Delta Traders'],
    ['h1', holder, 'Holder A'], ['h2', holder, 'Holder B'], ['h3', holder, 'Holder C'],
  ] as const;
  // Holder A pays Holder B and Holder C; Gamma Partners is tied to B and C, Delta Traders to A
  const links = [
    ['p1', paid, 'h1', 'h2'], ['p2', paid, 'h1', 'h3'],
    ['w1', owns, 'o1', 'h2'], ['w2', owns, 'o1', 'h3'], ['w3', owns, 'o2', 'h1'],
  ] as const;
  const lines = new Map<string, string>([...entities.map(([key, , title]) => [key, `${key}: ${title}`] as const), ...links.map(([key, type]) => [key, `${key}: ${type}`] as const)]);
  const end = (key: string): readonly [string, string] => {
    const found = entities.find(([own]) => own === key);
    return [found?.[1] ?? '', found?.[2] ?? ''];
  };
  const held: CheckedText = {
    text: [...lines.values()].join('\n'),
    keys: new Map([...lines.keys()].map((key) => [key, true])),
    lines,
    inexactCounts: [],
    unknownCountKeys: new Set(),
    elementTypes: new Map<string, string>([...entities.map(([key, type]) => [key, `entity ${type}`] as const), ...links.map(([key, type]) => [key, `relationship ${type}`] as const)]),
    elementNames: new Map(entities.map(([key, , title]) => [key, [title]])),
    elementEnds: new Map<string, readonly (readonly [string, string])[]>([...entities.map(([key]) => [key, [end(key)]] as const), ...links.map(([key, , from, to]) => [key, [end(from), end(to)]] as const)]),
    propertyKeys: new Map([['o1', [`${holder}Number`]]]),
    rankedValues: new Map([['o1', [{ key: `${holder}Number`, dataClass: 'string' }]]]),
  };
  const verdict = (text: string, cites: string[]): string => {
    const judged = judgeSentences([{ text, cites }], held);
    return judged.kept.length === 1 ? 'kept' : (judged.rejected[0]?.reason ?? 'none');
  };
  const paidOnly = ['p1', 'p2'];
  const live = `The other links in this read go toward Gamma Partners' ${holders}: Holder A leads to Holder B and Holder C.`;

  it('removes the sentence of the hand test, which cites no link of the one named, and keeps it with that link cited', () => {
    expect(verdict(live, paidOnly)).toBe('citation');
    expect(verdict(live, [...paidOnly, 'w1', 'w2'])).toBe('kept');
    expect(verdict(live, [...paidOnly, 'w1'])).toBe('kept');
  });

  it.each([
    `Gamma Partners' ${holders} are Holder B and Holder C.`,
    `Holder B and Holder C are ${holders} of Gamma Partners.`,
    `Holder B is the ${holder} belonging to Gamma Partners.`,
    `These are the ${holders} held by Gamma Partners.`,
    `Gamma Partners’s ${holder} is listed.`,
    `Gamma Partners' other ${holders} are listed.`,
    `Gamma Partners' 2 ${holders} are Holder B and Holder C.`,
    `Gamma Partners' other 2 ${holders} are listed.`,
  ])('asks for a link of the one named: %s', (text) => {
    expect(verdict(text, ['h2', 'h3'])).toBe('citation');
    expect(verdict(text, ['h2', 'h3', 'w1', 'w2'])).toBe('kept');
  });

  it('does not take a link of another for the one named', () => {
    expect(verdict(`Delta Traders' ${holders} are Holder B and Holder C.`, ['h2', 'h3', 'w1', 'w2'])).toBe('citation');
  });

  it.each([
    'Gamma Partners is listed beside Holder B.',
    `Gamma Partners' ${holder}Number is listed.`,
    `Gamma Partners' ${holder} number is listed.`,
    `The note "Gamma Partners' ${holders}" is on Holder B.`,
    `Holder B is one of the ${holders} shown.`,
  ])('asks for nothing where no possessive ties the name to an element: %s', (text) => {
    const judged = judgeSentences([{ text, cites: ['o1', 'h2'] }], { ...held, text: `${held.text} "Gamma Partners' ${holders}"` });
    expect(judged.rejected.map((each) => each.reason)).not.toContain('citation');
  });

  it('asks for nothing where the sentence cites no element but the one it names', () => {
    const read: CheckedText = { ...held, readKeys: new Set(['s1']), lines: new Map([...held.lines, ['s1', 's1: read of lookup: not yet retrieved']]), keys: new Map([...held.keys, ['s1', true]]) };
    const judged = judgeSentences([{ text: 'The relationships of Gamma Partners are not yet retrieved.', cites: ['o1', 's1'] }], read);
    expect(judged.kept).toHaveLength(1);
  });

  it('takes a cited read that counts the relationship ends of the one named for a number said of its relationships, and for nothing else', () => {
    const counted = (...anchors: string[]): CheckedText => ({
      ...held,
      readKeys: new Set(anchors.map((_, index) => `s${index + 1}`)),
      readElements: new Map(anchors.map((anchor, index) => [`s${index + 1}`, [anchor]])),
      lines: new Map([...held.lines, ...anchors.map((_, index) => [`s${index + 1}`, `s${index + 1}: read of degree: relationship ends by the type at the other end: all relationship ends ${index === 0 ? 12 : 8} (exact)`] as const)]),
      keys: new Map([...held.keys, ...anchors.map((_, index) => [`s${index + 1}`, true] as const)]),
    });
    const reasons = (text: string, anchors: string[], cites: string[] = ['o1', 'o2', 's1']): readonly string[] => judgeSentences([{ text, cites }], counted(...anchors)).rejected.map((each) => each.reason);
    for (const text of ["Gamma Partners' relationships number 12.", 'The links of Gamma Partners number 12.']) {
      expect(reasons(text, ['o1'])).not.toContain('citation');
      expect(reasons(text, ['o2'])).toContain('citation');
    }
    expect(reasons("Gamma Partners' relationships number 12 and Delta Traders' number 8.", ['o1', 'o2'], ['o1', 'o2', 's1', 's2'])).not.toContain('citation');
    // a count says nothing of where the relationships go
    for (const text of ["Gamma Partners' links include one to Holder B.", "Gamma Partners' relationships include 12 to Delta Traders.", "Gamma Partners' relationships include one to a customer.", "Gamma Partners' 12 links include one to Holder B."]) expect(reasons(text, ['o1'], ['o1', 'h2', 'o2', 's1']), text).toContain('citation');
    expect(reasons(`Gamma Partners' ${holders} number 12.`, ['o1'])).toContain('citation');
  });

  it(`asks for nothing of a property of the one named said with "of"`, () => {
    const named: CheckedText = { ...held, propertyKeys: new Map([['o1', [holder]]]), rankedValues: new Map([['o1', [{ key: holder, dataClass: 'string' }]]]) };
    expect(judgeSentences([{ text: `The ${holder} of Gamma Partners is listed beside Holder B.`, cites: ['o1', 'h2'] }], named).rejected.map((each) => each.reason)).not.toContain('citation');
    expect(verdict(`The ${holder} of Gamma Partners is Holder B.`, ['o1', 'h2'])).toBe('citation');
  });

  it('tells the model to cite the link', () => {
    expect(removalNoteOf([{ text: 'T.', reason: 'citation' }])).toContain('cite a relationship that joins it');
  });
});
