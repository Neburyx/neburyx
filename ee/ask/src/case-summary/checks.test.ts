import type { Count, GraphEdge, GraphNode, SummaryReading, SummarySentence } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { assembleText } from './assemble.js';
import { judgeSentences } from './checks.js';

const ref = (entityType: string, stableId: string) => ({ sourceId: 'demo', entityType, stableId });
const node = (stableId: string, title: string, entityType = 'widget'): GraphNode => ({ ref: ref(entityType, stableId), display: { title, type: entityType }, properties: [{ key: 'tier', value: 'gold', dataClass: 'text', masked: false }], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const aggregate = (id: string, from: GraphNode['ref'], to: GraphNode['ref'], count: Count): GraphEdge => ({
  ref: { sourceId: 'demo', aggregate: { type: 'USES', from, to } },
  memberCount: count,
  from,
  to,
  type: 'USES',
  direction: 'from-to',
  semantics: 'stored',
  properties: id === 'with-value' ? [{ key: 'weight', value: 48, dataClass: 'number', masked: false }] : [],
  evidenceRefs: [],
  qualityFlags: [],
});
const reading = (nodes: GraphNode[], edges: GraphEdge[] = []): SummaryReading => ({ nodes, edges, unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 });
const sentence = (text: string, ...cites: string[]): SummarySentence => ({ text, cites });

const ana = node('W-1', 'Ana Silva');
const bo = node('W-2', 'Bo Chen');
const base = assembleText(reading([ana, bo]));

const kept = (sentences: SummarySentence[], assembled = base): string[] => judgeSentences(sentences, assembled).kept.map((entry) => entry.text);

describe('the citation check', () => {
  it('keeps a sentence that cites keys that were sent, and removes one that cites none or a key that was not sent', () => {
    const result = judgeSentences([sentence('Two widgets are listed.', 'n1', 'n2'), sentence('A widget.'), sentence('A widget.', 'n9'), sentence('A widget.', 'n1', 'e5')], base);
    expect(result.kept.map((entry) => entry.cites)).toEqual([['n1', 'n2']]);
    expect(result.removed).toBe(3);
  });

  it('removes a sentence that cites the key of an end that was not read', () => {
    const lone = assembleText(reading([ana], [aggregate('x', ana.ref, ref('gadget', 'GT-9'), { quality: 'exact', value: 2, scope: 's' })]));
    expect(lone.keys.has('n2')).toBe(false);
    expect(kept([sentence('An end is cited.', 'n2')], lone)).toEqual([]);
  });

  it('keeps nothing of an empty list', () => {
    expect(judgeSentences([], base)).toEqual({ kept: [], removed: 0, rejected: [], verdictFound: false, keysStripped: 0, keysRemoved: 0 });
  });
});

describe('the number check', () => {
  it('keeps a sentence with no number and removes one with a number that the cited elements do not hold', () => {
    expect(kept([sentence('The widget is listed.', 'n1'), sentence('There are 7 widgets.', 'n1')])).toEqual(['The widget is listed.']);
  });

  it('removes a number the model counted itself', () => {
    expect(kept([sentence('2 accounts share a device.', 'n1', 'n2')])).toEqual([]);
  });

  it('does not take the digits of an id for a number, and keeps an id that was sent', () => {
    expect(kept([sentence('W-1 is listed.', 'n1')])).toEqual(['W-1 is listed.']);
    expect(kept([sentence('W-9 is listed.', 'n1')])).toEqual([]);
  });

  const exactBase = (count: Count) => assembleText(reading([ana, bo], [aggregate('with-value', ana.ref, bo.ref, count)]));

  it('requires the phrase of an estimated or lower-bound count when its number is stated', () => {
    for (const [count, phrase] of [
      [{ quality: 'estimated', value: 48, scope: 's' }, '~48 (estimated)'],
      [{ quality: 'lowerBound', value: 48, scope: 's' }, '≥ 48 (lower bound)'],
    ] as const) {
      const assembled = exactBase(count);
      expect(kept([sentence(`The relationship has 48 members.`, 'e1')], assembled)).toEqual([]);
      expect(kept([sentence(`The relationship has ${phrase} members.`, 'e1')], assembled)).toHaveLength(1);
    }
  });

  it('removes an invented number for a count that is not known, even when the number is on another property or element', () => {
    const unknown = exactBase({ quality: 'unknown', scope: 's' });
    expect(kept([sentence('The relationship has 48 members.', 'e1')], unknown)).toEqual([]);
    expect(kept([sentence('The relationship has 48 members.', 'e1', 'n1')], unknown)).toEqual([]);
    expect(kept([sentence('The relationship has members that are not known.', 'e1')], unknown)).toHaveLength(1);
  });

  it('accepts a decimal and a thousands separator when the cited line holds it', () => {
    const big = assembleText(reading([ana], [aggregate('x', ana.ref, ana.ref, { quality: 'exact', value: 1200, scope: 's' })]));
    expect(kept([sentence('It has 1,200 (exact) members.', 'e1')], big)).toHaveLength(1);
    expect(kept([sentence('It has 1200 (exact) members.', 'e1')], big)).toHaveLength(1);
    expect(kept([sentence('It has 1,201 (exact) members.', 'e1')], big)).toEqual([]);
  });
});

describe('the name check', () => {
  it.each([
    ['an id that was not sent', 'GT-9 is listed.'],
    ['a quoted text that was not sent', 'The widget is called "Mallory".'],
    ['a capitalised word that was not sent', 'The widget belongs to Mallory.'],
    ['an invented name at the start of a sentence', 'Mallory owns the widget.'],
  ])('removes a sentence with %s', (_name, text) => {
    expect(kept([sentence(text, 'n1')])).toEqual([]);
  });

  it.each([
    ['a title that was sent, quoted', 'The widget is called "Ana Silva".'],
    ['a name that was sent, unquoted', 'Ana Silva has a tier of gold.'],
    ['a shape word and an ordinary capital', 'Several elements have the shape of a fan-in and a rapid pass-through.'],
    ['an entity type that was sent, capitalised', 'Widget Ana Silva is listed.'],
  ])('keeps a sentence with %s', (_name, text) => {
    expect(kept([sentence(text, 'n1', 'n2')])).toEqual([text]);
  });

  it('does not find a lower-case invented name, which is the accepted limit', () => {
    expect(kept([sentence('The widget belongs to mallory.', 'n1')])).toEqual(['The widget belongs to mallory.']);
  });
});

describe('the name check and ordinary capitals', () => {
  const link = (type: string): GraphEdge => ({
    ref: { sourceId: 'demo', type, from: 'widget', to: 'widget', stableId: 'L-1' },
    from: ana.ref,
    to: bo.ref,
    type,
    direction: 'from-to',
    semantics: 'stored',
    properties: [],
    evidenceRefs: [],
    qualityFlags: [],
  });
  const linked = assembleText(reading([ana, bo], [link('LINKED_TO'), link('HELD_BY')]));
  const keptIn = (assembled: typeof linked, text: string, ...cites: string[]): string[] => judgeSentences([sentence(text, ...cites)], assembled).kept.map((entry) => entry.text);

  it.each([
    'A stored LINKED_TO relationship links W-1 to W-2.',
    'The HELD_BY link was observed.',
    'A stored linked_to relationship links W-1 to W-2.',
  ])('keeps a relationship type written as the elements give it, in capitals with an underscore: %s', (text) => {
    expect(keptIn(linked, text, 'n1', 'n2', 'e1')).toEqual([text]);
  });

  it('still removes a type in capitals that the text sent does not hold, an underscore word included', () => {
    expect(keptIn(linked, 'A stored OTHER_KIND relationship links W-1 to W-2.', 'n1', 'n2', 'e1')).toEqual([]);
    expect(keptIn(linked, 'A stored LINKED_FROM relationship links W-1 to W-2.', 'n1', 'n2', 'e1')).toEqual([]);
  });

  it.each([
    'Widgets W-1 and W-2 are listed.',
    'Taken together, the widgets are listed.',
    'Together, the widgets are listed.',
    'Linked W-1 and W-2 are listed.',
    'Overall, W-1 and W-2 are listed.',
  ])('keeps an ordinary word that opens the sentence with a capital: %s', (text) => {
    expect(keptIn(linked, text, 'n1', 'n2', 'e1')).toEqual([text]);
  });

  it.each([
    ['an invented name at the start', 'Mallory owns the widget W-1.'],
    ['an invented name at the start with a plural s', 'Mallorys widget W-1 is listed.'],
    ['an invented name at the start with an ordinary word after it', 'Mallory Stone has the widget W-1.'],
    ['an invented name after a full stop', 'The widget W-1 is listed. Mallory owns it.'],
    ['an invented name that is only a short prefix of a word of the text', 'Wid owns the widget W-1.'],
    ['an invented name in the middle of the sentence', 'The widget W-1 is owned by Mallory.'],
    ['an opener word in the middle of the sentence', 'The widget W-1 is owned by Overall.'],
    ['an opener word after a semicolon', 'W-1 is listed; Together owns it.'],
    ['an ordinary word of the text after a colon', 'W-1 is listed: Widgets own it.'],
    ['an invented stem of five letters that no word of the text starts with', 'Malle owns the widget W-1.'],
  ])('still removes %s', (_name, text) => {
    expect(keptIn(linked, text, 'n1', 'n2', 'e1')).toEqual([]);
  });
});

describe('the name check, the ids with underscores and hyphens, the decimals and the names of the text sent', () => {
  const idd = node('AC_7001-B', 'Mariana Lopez');
  const other = node('W-3', 'Christopher Banks');
  const named = assembleText(reading([idd, other]));
  const keptNamed = (text: string, ...cites: string[]): string[] => judgeSentences([sentence(text, ...cites)], named).kept.map((entry) => entry.text);

  it('keeps an id with an underscore and a hyphen that was sent, and removes one that was not', () => {
    expect(keptNamed('AC_7001-B is listed.', 'n1')).toEqual(['AC_7001-B is listed.']);
    expect(keptNamed('AC_7002-B is listed.', 'n1')).toEqual([]);
  });

  it('keeps a word in Markdown emphasis that an underscore wraps, as it kept it before', () => {
    expect(keptNamed('The _shared_ widget is listed.', 'n1')).toEqual(['The _shared_ widget is listed.']);
  });

  it('removes a made-up name at the start that is a variant, a prefix or a plural of a name that was sent: a name of the text sent is not an ordinary word', () => {
    for (const text of ['Maria owns W-3.', 'Marian owns W-3.', 'Chris owns W-3.', 'Chris Banks owns W-3.', 'Lopezs owns W-3.']) expect(keptNamed(text, 'n1', 'n2'), text).toEqual([]);
  });

  it('keeps a name that was sent, whole, at the start', () => {
    expect(keptNamed('Mariana Lopez owns W-3.', 'n1', 'n2')).toEqual(['Mariana Lopez owns W-3.']);
  });

  it('does not read what follows a decimal as the start of a sentence, and reads the start of the next sentence as one, also after an id with digits', () => {
    const rated = assembleText(reading([{ ...idd, properties: [{ key: 'rate', value: '3.5', dataClass: 'number', masked: false }] }]));
    const keptRated = (text: string): string[] => judgeSentences([sentence(text, 'n1')], rated).kept.map((entry) => entry.text);
    expect(keptRated('A sum of 3.5 Overall is listed.')).toEqual([]);
    expect(keptRated('The figure 3.5 is listed. Overall, AC_7001-B is listed.')).toEqual(['The figure 3.5 is listed. Overall, AC_7001-B is listed.']);
    expect(keptRated('The rate of AC_7001-B is 3.5. Overall, it is listed.')).toEqual(['The rate of AC_7001-B is 3.5. Overall, it is listed.']);
  });

  it('reads a sentence with leading whitespace, and a text in a decomposed form, as the same sentence', () => {
    expect(keptNamed('  Overall, AC_7001-B is listed.', 'n1')).toEqual(['  Overall, AC_7001-B is listed.']);
    const accented = assembleText(reading([node('W-5', 'Zoë Kim', 'élément')]));
    expect(judgeSentences([sentence('Éléments Zoë Kim is listed.'.normalize('NFD'), 'n1')], accented).kept).toHaveLength(1);
  });

  it('gives a capitalised word after an id with digits at the start of a sentence the rules of a start, which an invented name does not pass', () => {
    expect(keptNamed('W-3 Overall is listed.', 'n1', 'n2')).toEqual(['W-3 Overall is listed.']);
    expect(keptNamed('W-3 Mallory is listed.', 'n1', 'n2')).toEqual([]);
  });
});

describe('the verdict check', () => {
  it.each(['The account is guilty.', 'It was done intentionally.', 'This looks fraudulent.', 'Money laundering is shown.', 'Suspicious activity.', 'They are responsible for it.', 'A crime is shown.', 'The offence is clear.', 'It proves the link.', 'We conclude that it is so.'])('finds %j', (text) => {
    const result = judgeSentences([sentence(text, 'n1')], base);
    expect(result).toMatchObject({ kept: [], removed: 1, verdictFound: true });
  });

  it.each(['Two widgets are listed.', 'A cycle of three transfers is listed.', 'The widget is a member of group K.', 'It has the shape of a fan-in.', 'An inconclusive link is listed.', 'The widgets share a device.'])('does not find %j', (text) => {
    expect(judgeSentences([sentence(text, 'n1')], assembleText(reading([ana, bo]))).verdictFound).toBe(false);
  });

  it('counts a sentence removed by two checks once', () => {
    expect(judgeSentences([sentence('A guilty account GT-9 of 7 sums.', 'n9')], base)).toMatchObject({ removed: 1, verdictFound: true });
  });
});

describe('the verdict check and the title or id of an element the sentence cites', () => {
  const crimson = node('W-7', 'Crimson Lake Traders');
  const fraud = node('FRAUD-7', 'Fraud Prevention Ltd', 'company');
  const special = node('W-8', 'Intent (Freight) & Sons');
  const named = assembleText(reading([crimson, fraud, special, ana]));
  const keyOf = (title: string): string => [...named.lines].find(([, line]) => line.includes(`title: ${JSON.stringify(title)}`))?.[0] ?? 'missing';
  const verdictOf = (text: string, ...cites: string[]) => judgeSentences([sentence(text, ...cites)], named);

  it('keeps a sentence that quotes the title of an element it cites, and does not call for a further call', () => {
    expect(verdictOf('Crimson Lake Traders is listed.', keyOf('Crimson Lake Traders'))).toMatchObject({ removed: 0, verdictFound: false });
    expect(verdictOf('crimson lake traders is listed.', keyOf('Crimson Lake Traders'))).toMatchObject({ removed: 0, verdictFound: false });
    expect(verdictOf('Fraud Prevention Ltd is listed.', keyOf('Fraud Prevention Ltd'))).toMatchObject({ removed: 0, verdictFound: false });
    expect(verdictOf('Intent (Freight) & Sons is listed.', keyOf('Intent (Freight) & Sons'))).toMatchObject({ removed: 0, verdictFound: false });
  });

  it('keeps a sentence that names an element by an id that holds a verdict word, when it cites that element', () => {
    expect(verdictOf('The company FRAUD-7 is listed.', keyOf('Fraud Prevention Ltd'))).toMatchObject({ removed: 0, verdictFound: false });
  });

  it('still removes the same words anywhere else: a verdict beside the title, a verdict with no title, and a title the sentence does not cite', () => {
    expect(verdictOf('Crimson Lake Traders committed fraud.', keyOf('Crimson Lake Traders'))).toMatchObject({ kept: [], removed: 1, verdictFound: true });
    expect(verdictOf('This is fraud.', keyOf('Crimson Lake Traders'))).toMatchObject({ kept: [], removed: 1, verdictFound: true });
    expect(verdictOf('Fraud Prevention Ltd is listed.', keyOf('Crimson Lake Traders'))).toMatchObject({ kept: [], removed: 1, verdictFound: true });
    expect(verdictOf('The account is guilty.', 'n1')).toMatchObject({ kept: [], removed: 1, verdictFound: true });
  });

  it('takes a title out only as a whole: a short title does not cut a verdict word out of a longer one, and the longest title goes first', () => {
    const short = node('W-21', 'Ra');
    const mid = node('W-22', 'Del');
    const prevention = node('W-23', 'Prevention');
    const shorts = assembleText(reading([short, mid, prevention, fraud]));
    const key = (title: string): string => [...shorts.lines].find(([, line]) => line.includes(`title: ${JSON.stringify(title)}`))?.[0] ?? 'missing';
    expect(judgeSentences([sentence('AC-1 shows fraud.', key('Ra'))], shorts)).toMatchObject({ kept: [], removed: 1, verdictFound: true });
    expect(judgeSentences([sentence('AC-2 acted deliberately.', key('Del'))], shorts)).toMatchObject({ kept: [], removed: 1, verdictFound: true });
    expect(judgeSentences([sentence('Fraud Prevention Ltd is listed.', key('Prevention'), key('Fraud Prevention Ltd'))], shorts)).toMatchObject({ removed: 0, verdictFound: false });
  });

  it('has a stated limit: an element whose title is only a word of the list hides that word in a sentence that cites it', () => {
    const only = node('W-24', 'Fraud', 'company');
    const alone = assembleText(reading([only]));
    expect(judgeSentences([sentence('The holder committed fraud.', 'n1')], alone)).toMatchObject({ removed: 0, verdictFound: false });
  });

  it('removes a verdict inside a title of the sentence when it cites a key that was not sent (no title is ignored for an element that is not there)', () => {
    expect(verdictOf('Crimson Lake Traders is listed.', 'n99')).toMatchObject({ kept: [], removed: 1, verdictFound: true });
  });
});

describe('the boundaries of the checks', () => {
  it.each(['The value is -999.', 'The value is .999.', 'The value is +7.', 'The value is 999.5.'])('removes the absent number in %j', (text) => {
    expect(kept([sentence(text, 'n1')])).toEqual([]);
  });

  it('keeps a signed number or a leading point when the cited line holds it, and a date whose parts are on the line', () => {
    const dated = assembleText(reading([ana], [{ ...aggregate('x', ana.ref, ana.ref, { quality: 'exact', value: 3, scope: 's' }), observedAt: '2026-01-02' }]));
    expect(kept([sentence('It was observed at 2026-01-02.', 'e1')], dated)).toHaveLength(1);
    expect(kept([sentence('It was observed at 2026-01-03.', 'e1')], dated)).toEqual([]);
  });

  it('does not read a quoted text as a number, so a quoted 48 beside an estimated count of 48 is kept', () => {
    const quoted = assembleText(reading([{ ...ana, properties: [{ key: 'label', value: '48', dataClass: 'text', masked: false }] }, bo], [aggregate('x', ana.ref, bo.ref, { quality: 'estimated', value: 48, scope: 's' })]));
    expect(kept([sentence('The label is "48".', 'n1')], quoted)).toHaveLength(1);
    expect(kept([sentence('The relationship has 48 members.', 'e1')], quoted)).toEqual([]);
  });

  it('matches whole identifier tokens: W-1 is not found in a text that holds only W-10', () => {
    const tens = assembleText(reading([node('W-10', 'Ten')]));
    expect(kept([sentence('W-1 is listed.', 'n1')], tens)).toEqual([]);
    expect(kept([sentence('W-10 is listed.', 'n1')], tens)).toHaveLength(1);
  });

  it('finds an unsent capitalised word in another script or with an accent', () => {
    expect(kept([sentence('The widget belongs to Élodie.', 'n1')])).toEqual([]);
    expect(kept([sentence('The widget belongs to Ånders.', 'n1')])).toEqual([]);
    const accented = assembleText(reading([node('W-1', 'Élodie')]));
    expect(kept([sentence('The widget belongs to Élodie.', 'n1')], accented)).toHaveLength(1);
  });

  it.each(['They are responsible  for it.', 'They are responsible\nfor it.', 'They are responsible\tfor it.'])('finds the phrase split by whitespace in %j', (text) => {
    expect(judgeSentences([sentence(text, 'n1')], base).verdictFound).toBe(true);
  });
});

describe('quoted text and identifiers that hold digits', () => {
  it('grounds a quoted number in the lines of the cited elements, and a quoted id as a whole', () => {
    const other = assembleText(reading([ana, { ...bo, properties: [{ key: 'label', value: '48', dataClass: 'text', masked: false }] }]));
    expect(kept([sentence('The label is "48".', 'n1')], other)).toEqual([]);
    expect(kept([sentence('The label is "48".', 'n2')], other)).toHaveLength(1);
    const tens = assembleText(reading([node('W-10', 'Ten')]));
    expect(kept([sentence('The widget is "W-1".', 'n1')], tens)).toEqual([]);
    expect(kept([sentence('The widget is "W-10".', 'n1')], tens)).toHaveLength(1);
  });

  it.each(['Ω1', 'Ж1', 'ß2'])('finds the unsent identifier %s with a Unicode letter, and keeps it when it was sent', (id) => {
    const sentOnly = assembleText(reading([node(id, 'Odd')]));
    expect(kept([sentence(`The id is ${id}.`, 'n1')], sentOnly)).toHaveLength(1);
    expect(kept([sentence(`The id is ${id}.`, 'n1')], assembleText(reading([node('W-1', 'Odd')])))).toEqual([]);
  });

  it('does not take the digits of a digit-leading identifier for a number', () => {
    const odd = assembleText(reading([node('123ABC', 'Odd')]));
    expect(kept([sentence('The value is 123.', 'n1')], odd)).toEqual([]);
    expect(kept([sentence('The id is 123ABC.', 'n1')], odd)).toHaveLength(1);
  });
});

describe('the forms of the verdict words', () => {
  const FORMS: Record<string, string[]> = {
    guilt: ['guilt', 'guilty', 'GUILTY'],
    fraud: ['fraud', 'fraudulent', 'fraudster', 'Fraud'],
    launder: ['launder', 'laundering', 'laundered', 'LAUNDERING'],
    crim: ['crime', 'crimes', 'criminal', 'criminality'],
    offence: ['offence', 'offense', 'offences', 'offender', 'offenders'],
    suspect: ['suspect', 'suspects', 'suspected', 'suspicion', 'suspicious'],
    intent: ['intent', 'intents', 'intention', 'intentional', 'intentionally'],
    deliberate: ['deliberate', 'deliberately'],
    unlawful: ['illegal', 'illegally', 'unlawful', 'unlawfully'],
    convict: ['convict', 'convicted', 'conviction'],
    persons: ['culprit', 'culprits', 'perpetrator', 'perpetrators'],
    conclude: ['conclude', 'concluded', 'concludes', 'conclusion', 'conclusions'],
    prove: ['prove', 'proves', 'proof', 'PROOF'],
    phrase: ['responsible for', 'Responsible For'],
  };
  it.each(Object.entries(FORMS).flatMap(([stem, forms]) => forms.map((form) => [stem, form] as const)))('finds %s in the form %s', (_stem, form) => {
    expect(judgeSentences([sentence(`This is a ${form} here.`, 'n1')], base).verdictFound).toBe(true);
  });

  it.each(['inconclusive', 'improve', 'reprove', 'misconstrue', 'responsibly', 'prefraud'])('does not find the word %s', (word) => {
    expect(judgeSentences([sentence(`This is ${word} here.`, 'n1')], base).verdictFound).toBe(false);
  });
});

describe('the keys in the text of a sentence', () => {
  const judged = (text: string, ...cites: string[]) => judgeSentences([sentence(text, ...cites)], base);

  it.each([
    ['Ana Silva and Bo Chen are listed (n1, n2).', 'Ana Silva and Bo Chen are listed.'],
    ['Ana Silva is listed (n1).', 'Ana Silva is listed.'],
    ['Ana Silva is listed [n1].', 'Ana Silva is listed.'],
    ['Ana Silva and Bo Chen (n1 and n2) are listed.', 'Ana Silva and Bo Chen are listed.'],
    ['Ana Silva ( n1 ; n2 ) is listed.', 'Ana Silva is listed.'],
  ])('takes a key in parentheses out of %s, keeps the rest as it was and counts it', (text, expected) => {
    const result = judged(text, 'n1', 'n2');
    expect(result.kept.map((entry) => entry.text)).toEqual([expected]);
    expect(result.kept[0]?.cites).toEqual(['n1', 'n2']);
    expect(result).toMatchObject({ removed: 0, keysStripped: 1, keysRemoved: 0 });
  });

  it.each(['n1 and n2 are listed together.', 'The widget n1 is listed.', 'Ana Silva is listed with n2.', 'Ana Silva is listed (see n1).', 'Ana Silva is listed (n1 and the widget n2).'])('removes %s: a key outside parentheses stands for a name', (text) => {
    const result = judged(text, 'n1', 'n2');
    expect(result).toMatchObject({ kept: [], removed: 1, keysRemoved: 1, keysStripped: 0 });
  });

  it('removes a sentence that holds nothing but a key', () => {
    expect(judged('(n1)', 'n1')).toMatchObject({ kept: [], removed: 1 });
  });

  it('leaves a sentence with no key as it was, counting nothing', () => {
    expect(judged('Ana Silva is listed.', 'n1')).toMatchObject({ removed: 0, keysStripped: 0, keysRemoved: 0 });
  });

  it('is not this check that removes a key that was not sent: the name check does, and nothing is counted as a key removal', () => {
    expect(judged('Ana Silva is listed (n99).', 'n1')).toMatchObject({ kept: [], removed: 1, keysRemoved: 0, keysStripped: 0 });
  });

  it('judges the stripped text with the other checks: the number check still applies', () => {
    expect(judged('Ana Silva has 5 devices (n1).', 'n1')).toMatchObject({ kept: [], removed: 1 });
  });

  it('keeps a word that only looks like a key: an upper-case N1, an id or a longer token are not keys', () => {
    const lone = assembleText(reading([node('N1', 'Nina')]));
    expect(judgeSentences([sentence('Nina N1 is listed.', 'n1')], lone)).toMatchObject({ kept: [{ text: 'Nina N1 is listed.' }], keysRemoved: 0 });
    expect(judged('Ana Silva is listed (n1x).', 'n1').kept).toEqual([]);
  });

  it('still re-asks for a sentence that states a verdict and holds a bare key: the verdict is found first', () => {
    expect(judged('n1 laundered money via n2.', 'n1', 'n2')).toMatchObject({ kept: [], removed: 1, verdictFound: true, keysRemoved: 0 });
  });

  it('leaves a group that holds a key that was not sent to the name check, and counts no key removal', () => {
    expect(judged('Ana Silva is listed (n1, n99).', 'n1')).toMatchObject({ kept: [], removed: 1, keysRemoved: 0, keysStripped: 0 });
  });

  it('changes only the place a key was taken out of: a quoted text with a double space beside a stripped key is still not found', () => {
    expect(judged('Ana Silva is called "Ana  Silva" (n1).', 'n1')).toMatchObject({ kept: [], removed: 1 });
    expect(judged('Ana Silva  is listed (n1) .', 'n1').kept.map((entry) => entry.text)).toEqual(['Ana Silva  is listed .']);
  });

  it('takes a relationship key out as well', () => {
    const withEdge = assembleText(reading([ana, bo], [aggregate('x', ana.ref, bo.ref, { quality: 'exact', value: 2, scope: 's' })]));
    const result = judgeSentences([sentence('Ana Silva uses Bo Chen (e1).', 'n1', 'e1')], withEdge);
    expect(result.kept.map((entry) => entry.text)).toEqual(['Ana Silva uses Bo Chen.']);
  });
});
