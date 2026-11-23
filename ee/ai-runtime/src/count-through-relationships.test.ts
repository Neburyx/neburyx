import { describe, expect, it } from 'vitest';
import { judgeSentences, type CheckedText, type EntityEnd } from './reply-checks.js';

/** The sentences of a hand test that were removed: a count of the entities a sentence names, cited through the relationship lines that end at them. */
interface Vocabulary {
  readonly name: string;
  readonly thing: string;
  readonly things: string;
  readonly owner: string;
  readonly link: string;
  readonly ids: readonly [string, string, string];
  readonly owners: readonly [string, string, string];
  readonly sentences: readonly [string, string, string, string];
}

const VOCABULARIES: readonly Vocabulary[] = [
  {
    name: 'transactions',
    thing: 'Transaction',
    things: 'transactions',
    owner: 'Account',
    link: 'SENT',
    ids: ['TX-004833841', 'TX-004833844', 'TX-004833978'],
    owners: ['350728:81297C3A0', '350852:812A296C0', '326563:8131C6E50'],
    sentences: ['Of these three transactions, none share a sending account.', 'The senders of three transactions were read: TX-004833841, TX-004833844 and TX-004833978.', 'Of the 3 transactions read, TX-004833841, TX-004833844 and TX-004833978, none share a sender.', 'No two of these three transactions have the same sender.'],
  },
  {
    name: 'claims',
    thing: 'Claim',
    things: 'claims',
    owner: 'Provider',
    link: 'FILED_BY',
    ids: ['CL-1001', 'CL-1002', 'CL-1003'],
    owners: ['PV-11', 'PV-12', 'PV-13'],
    sentences: ['Of these three claims, none share a filing provider.', 'The providers of three claims were read: CL-1001, CL-1002 and CL-1003.', 'Of the 3 claims read, CL-1001, CL-1002 and CL-1003, none share a provider.', 'No two of these three claims have the same provider.'],
  },
];

function held(vocabulary: Vocabulary, ends: readonly (readonly [string, string])[]): CheckedText {
  const lines = new Map<string, string>();
  const elementTypes = new Map<string, string>();
  const elementEnds = new Map<string, readonly (readonly [string, string])[]>();
  const elementNames = new Map<string, readonly string[]>();
  ends.forEach(([owner, id], index) => {
    const own = `r${index * 2 + 1}`;
    const link = `r${index * 2 + 2}`;
    lines.set(own, `${own}: ${vocabulary.owner.toLowerCase()}: ${vocabulary.owner} ${owner} | id: "${owner}"`);
    elementTypes.set(own, `entity ${vocabulary.owner.toLowerCase()}`);
    elementEnds.set(own, [[vocabulary.owner.toLowerCase(), owner]]);
    elementNames.set(own, [`${vocabulary.owner} ${owner}`, owner]);
    lines.set(link, `${link}: ${vocabulary.link}: ${vocabulary.owner} ${owner} → ${vocabulary.thing} ${id} | stored | members: 1 (exact)`);
    elementTypes.set(link, `relationship ${vocabulary.link}`);
    elementEnds.set(link, [[vocabulary.owner.toLowerCase(), owner], [vocabulary.thing.toLowerCase(), id]]);
    elementNames.set(link, [`${vocabulary.owner} ${owner} → ${vocabulary.thing} ${id}`, id]);
  });
  return { text: [...lines.values()].join('\n'), keys: new Map([...lines.keys()].map((key) => [key, true] as const)), lines, inexactCounts: [], unknownCountKeys: new Set(), elementTypes, elementEnds, elementNames };
}

describe.each(VOCABULARIES)('a count of the $name that the sentence cites through the lines of the relationships that end at them', (vocabulary) => {
  const pairs = vocabulary.ids.map((id, index) => [vocabulary.owners[index] ?? '', id] as const);
  const text = held(vocabulary, pairs);
  const links = ['r2', 'r4', 'r6'];
  const kept = (sentence: string, cites: string[], over: CheckedText = text): boolean => judgeSentences([{ text: sentence, cites }], over).kept.length === 1;

  it('keeps the exact sentences of the hand test, as a number word and as a digit', () => {
    for (const sentence of vocabulary.sentences) expect(judgeSentences([{ text: sentence, cites: links }], text).rejected.map((r) => r.reason), sentence).toEqual([]);
    expect(kept(`The senders of 3 ${vocabulary.things} were read.`, links)).toBe(true);
    // the lines of the owners cited beside them change nothing
    for (const sentence of vocabulary.sentences) expect(kept(sentence, ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']), sentence).toBe(true);
  });

  it('removes a count that is not the number of distinct entities of that type the cited relationships end at, in words and in digits', () => {
    for (const wrong of ['two', 'four', '2', '4']) expect(kept(`The senders of ${wrong} ${vocabulary.things} were read.`, links), wrong).toBe(false);
    // two relationships that end at one entity name one, not two or three
    const twice = held(vocabulary, [[vocabulary.owners[0], vocabulary.ids[0]], [vocabulary.owners[1], vocabulary.ids[0]], [vocabulary.owners[2], vocabulary.ids[0]]]);
    expect(kept(`The senders of three ${vocabulary.things} were read.`, links, twice)).toBe(false);
    expect(kept(`The sender of one ${vocabulary.thing.toLowerCase()} was read.`, links, twice)).toBe(true);
    // a cited relationship that is not cited is not counted
    expect(kept(`The senders of three ${vocabulary.things} were read.`, ['r2', 'r4'])).toBe(false);
    expect(kept(`The senders of two ${vocabulary.things} were read.`, ['r2', 'r4'])).toBe(true);
  });

  it('counts the entities of the other type the same way, and no type the relationships do not end at', () => {
    expect(kept(`The ${vocabulary.owner.toLowerCase()}s of three ${vocabulary.things} were read.`, links)).toBe(true);
    expect(kept(`Five ${vocabulary.things} were read.`, links)).toBe(false);
  });

  it('reads the first person as language, not as a name: the exact sentence is kept when its figures are backed, and a made-up capitalised name is still removed', () => {
    const owner = vocabulary.owner.toLowerCase();
    for (const opening of ['I read', "I've read", "I'm reading", "I'd read"]) expect(kept(`${opening} the sender of three ${vocabulary.things}: ${vocabulary.ids.join(', ')}.`, links), opening).toBe(true);
    expect(kept(`I read the sender of four ${vocabulary.things}.`, links)).toBe(false);
    expect(judgeSentences([{ text: `I read the ${owner} Zorblax of three ${vocabulary.things}.`, cites: links }], text).rejected.map((entry) => entry.reason)).toEqual(['name']);
    expect(judgeSentences([{ text: `Zorblax read the sender of three ${vocabulary.things}.`, cites: links }], text).rejected.map((entry) => entry.reason)).toEqual(['name']);
  });

  it('takes "no two" and "any two" for a pair of the set, not for a count of what is cited, and leaves the digit as it was without the ends', () => {
    const owner = vocabulary.owner.toLowerCase();
    const without: CheckedText = { ...text, elementEnds: undefined };
    for (const opening of ['No two', 'Any two']) {
      const sentence = `${opening} ${vocabulary.things} share a ${owner}.`;
      expect(kept(sentence, links), sentence).toBe(true);
      expect(kept(sentence, links, without), sentence).toBe(true);
    }
    for (const digit of [`No 2 ${vocabulary.things} share a ${owner}.`, `Any 2 ${vocabulary.things} share a ${owner}.`]) expect(kept(digit, links), digit).toBe(kept(digit, links, without));
    // a count that is no pair stays a count
    expect(kept(`Four ${vocabulary.things} share a ${owner}.`, links)).toBe(false);
  });
});

describe.each(VOCABULARIES)('a count of the $name that the sentence cites, with a target it names apart', (vocabulary) => {
  const type = vocabulary.thing.toLowerCase();
  /** Three entities joined by two relationships that end at the third; `names` is what the text sent gives each (the title, and an id only where a line prints it). */
  const joined = (titles: readonly [string, string, string], names: readonly [readonly string[], readonly string[], readonly string[]], extra = '', members = '1'): CheckedText => {
    const lines = new Map<string, string>();
    const elementTypes = new Map<string, string>();
    const elementEnds = new Map<string, readonly EntityEnd[]>();
    const elementNames = new Map<string, readonly string[]>();
    const [first = '', second = '', target = ''] = vocabulary.ids;
    const ends = (id: string, index: number): EntityEnd => [type, id, ...(names[index] ?? [])];
    [first, second].forEach((id, index) => {
      const key = `r${index + 1}`;
      lines.set(key, `${key}: ${vocabulary.link}: ${vocabulary.thing} ${titles[index] ?? ''} → ${vocabulary.thing} ${titles[2]} | stored | members: ${members} (exact)${extra}`);
      elementTypes.set(key, `relationship ${vocabulary.link}`);
      elementEnds.set(key, [ends(id, index), ends(target, 2)]);
      elementNames.set(key, [`${vocabulary.thing} ${titles[index] ?? ''} → ${vocabulary.thing} ${titles[2]}`]);
    });
    return { text: [...lines.values()].join('\n'), keys: new Map([...lines.keys()].map((key) => [key, true] as const)), lines, inexactCounts: [], unknownCountKeys: new Set(), elementTypes, elementEnds, elementNames };
  };
  const kept = (sentence: string, over: CheckedText): boolean => judgeSentences([{ text: sentence, cites: ['r1', 'r2'] }], over).kept.length === 1;
  const plain = joined(['Alpha', 'Beta', 'Gamma'], [['Alpha'], ['Beta'], ['Gamma']]);

  it('leaves the target out of the count when the sentence names it, in words and in digits, and counts the three when it names none', () => {
    expect(kept(`Two ${vocabulary.things} sent to Gamma.`, plain)).toBe(true);
    expect(kept(`2 ${vocabulary.things} sent to Gamma.`, plain)).toBe(true);
    expect(kept(`Three ${vocabulary.things} are joined by the two relationships.`, plain)).toBe(true);
    expect(kept(`Four ${vocabulary.things} sent to Gamma.`, plain)).toBe(false);
    expect(kept(`4 ${vocabulary.things} sent to Gamma.`, plain)).toBe(false);
    expect(kept(`Five ${vocabulary.things} are joined by the two relationships.`, plain)).toBe(false);
  });

  it('subtracts no name that two of the cited entities share: it names neither of them apart', () => {
    const shared = joined(['Same', 'Same', 'Other'], [['Same'], ['Same'], ['Other']], '', '7');
    expect(kept(`Two ${vocabulary.things} sent to Same.`, shared)).toBe(false);
    expect(kept(`1 ${vocabulary.thing.toLowerCase()} sent to Same.`, shared)).toBe(false);
    expect(kept(`Two ${vocabulary.things} sent to Other.`, shared)).toBe(true);
  });

  it('knows the list of end names that belongs to the count, so that only the target is apart', () => {
    expect(kept(`Two ${vocabulary.things}, Alpha and Beta, sent to Gamma.`, plain)).toBe(true);
    expect(kept(`2 ${vocabulary.things}, Alpha and Beta, sent to Gamma.`, plain)).toBe(true);
    // a list that is no part of the count leaves the count as it was
    expect(kept(`Three ${vocabulary.things}, Alpha and Beta, sent to Gamma.`, plain)).toBe(true);
    expect(kept(`Four ${vocabulary.things}, Alpha and Beta, sent to Gamma.`, plain)).toBe(false);
  });

  it('matches only a name the text sent gave the entity, never its stable id that no line prints', () => {
    const [, , target = ''] = vocabulary.ids;
    // the id is in the text sent as the value of an unrelated property, never as the entity's identity
    const unsent = joined(['Alpha', 'Beta', 'Gamma'], [['Alpha'], ['Beta'], ['Gamma']], ` | reference: "${target}"`);
    expect(kept(`Two ${vocabulary.things} sent to ${target}.`, unsent)).toBe(false);
    // the id is a name once a line prints it as the entity's identity
    const printed = joined(['Alpha', 'Beta', 'Gamma'], [['Alpha'], ['Beta'], ['Gamma', target]], ` | reference: "${target}"`);
    expect(kept(`Two ${vocabulary.things} sent to ${target}.`, printed)).toBe(true);
    expect(kept(`Two ${vocabulary.things} sent to Gamma.`, printed)).toBe(true);
  });

  it('reads an end name and the sentence in the same normal form', () => {
    const decomposed = joined(['Alpha', 'Beta', 'Cafe\u0301'], [['Alpha'], ['Beta'], ['Cafe\u0301']]);
    expect(kept(`Two ${vocabulary.things} sent to Caf\u00e9.`, decomposed)).toBe(true);
    expect(kept(`Two ${vocabulary.things} sent to Cafe\u0301.`, decomposed)).toBe(true);
    expect(kept(`Four ${vocabulary.things} sent to Caf\u00e9.`, decomposed)).toBe(false);
  });
});
