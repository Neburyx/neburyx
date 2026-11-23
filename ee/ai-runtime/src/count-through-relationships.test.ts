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

describe.each(VOCABULARIES)('a count of the $name that the sentence cites, beside the relationship that joins them', (vocabulary) => {
  const type = vocabulary.thing.toLowerCase();
  const names = ['Alpha', 'Beta', 'Gamma'];
  /** Entity lines for the first `entities` of the three, and one relationship line from the first to each of the others; the count a line prints is 7, so that no digit of a count is backed by it. */
  const joined = (entities: number, targets: number): CheckedText => {
    const lines = new Map<string, string>();
    const elementTypes = new Map<string, string>();
    const elementEnds = new Map<string, readonly EntityEnd[]>();
    const elementNames = new Map<string, readonly string[]>();
    const [first = '', second = '', third = ''] = vocabulary.ids;
    const ids = [first, second, third];
    for (let index = 0; index < entities; index += 1) {
      const key = `e${index + 1}`;
      lines.set(key, `${key}: ${type}: ${vocabulary.thing} ${names[index] ?? ''}`);
      elementTypes.set(key, `entity ${type}`);
      elementEnds.set(key, [[type, ids[index] ?? '']]);
      elementNames.set(key, [names[index] ?? '']);
    }
    for (let index = 1; index <= targets; index += 1) {
      const key = `r${index}`;
      lines.set(key, `${key}: ${vocabulary.link}: ${vocabulary.thing} Alpha → ${vocabulary.thing} ${names[index] ?? ''} | stored | members: 7 (exact)`);
      elementTypes.set(key, `relationship ${vocabulary.link}`);
      elementEnds.set(key, [[type, first], [type, ids[index] ?? '']]);
      elementNames.set(key, [`${vocabulary.thing} Alpha → ${vocabulary.thing} ${names[index] ?? ''}`]);
    }
    return { text: [...lines.values()].join('\n'), keys: new Map([...lines.keys()].map((key) => [key, true] as const)), lines, inexactCounts: [], unknownCountKeys: new Set(), elementTypes, elementEnds, elementNames };
  };
  const kept = (sentence: string, cites: string[], over: CheckedText): boolean => judgeSentences([{ text: sentence, cites }], over).kept.length === 1;

  it('counts the distinct entities at the ends when a cited relationship joins one that is not cited: the cited entity alone is no count of them', () => {
    const one = joined(1, 1);
    expect(kept(`The relationship joins 2 ${vocabulary.things}.`, ['e1', 'r1'], one)).toBe(true);
    expect(kept(`The relationship joins two ${vocabulary.things}.`, ['e1', 'r1'], one)).toBe(true);
    expect(kept(`The relationship joins 1 ${vocabulary.thing.toLowerCase()}.`, ['e1', 'r1'], one)).toBe(false);
    expect(kept(`The relationship joins 3 ${vocabulary.things}.`, ['e1', 'r1'], one)).toBe(false);
    // with every end cited, the cited entities are the ends and the count is as it was
    const all = joined(3, 2);
    expect(kept(`The relationships join 3 ${vocabulary.things}.`, ['e1', 'e2', 'e3', 'r1', 'r2'], all)).toBe(true);
    expect(kept(`The relationships join 2 ${vocabulary.things}.`, ['e1', 'e2', 'e3', 'r1', 'r2'], all)).toBe(false);
  });

  it('verifies no count of entities when a cited entity has no end data of its own', () => {
    const all = joined(3, 1);
    const elementEnds = new Map(all.elementEnds);
    elementEnds.delete('e3');
    const missing: CheckedText = { ...all, elementEnds };
    // Alpha and Gamma are cited and Alpha → Beta: three widgets, of which only two have ends known
    for (const count of ['2', '3']) expect(kept(`The elements show ${count} ${vocabulary.things}.`, ['e1', 'e3', 'r1'], missing), count).toBe(false);
    expect(kept(`The elements show 2 ${vocabulary.things}.`, ['e1', 'e3', 'r1'], all)).toBe(false);
    expect(kept(`The elements show 3 ${vocabulary.things}.`, ['e1', 'e3', 'r1'], all)).toBe(true);
  });

  it('keeps the count of cited entities with none adjusted for a name when no relationship adds an end, and counts no name apart through a relationship', () => {
    const entities = joined(3, 0);
    expect(kept(`3 ${vocabulary.things} were read.`, ['e1', 'e2', 'e3'], entities)).toBe(true);
    expect(kept(`2 ${vocabulary.things}, Alpha and Beta, sent to Gamma.`, ['e1', 'e2', 'e3'], entities)).toBe(true);
    // the known limit: two of the three ends, the target named apart, is no count of the ends
    const through = joined(1, 2);
    expect(kept(`2 ${vocabulary.things} sent to Gamma.`, ['r1', 'r2'], through)).toBe(false);
    expect(kept(`Two ${vocabulary.things} sent to Gamma.`, ['r1', 'r2'], through)).toBe(false);
    expect(kept(`3 ${vocabulary.things} are joined by the two relationships.`, ['r1', 'r2'], through)).toBe(true);
  });
});
