import { describe, expect, it } from 'vitest';
import { judgeSentences, type CheckedText, type RankedProperty } from './reply-checks.js';

describe.each([
  { type: 'widget', many: 'widgets', key: 'amountValue', names: ['Item A', 'Item B', 'Item C'] },
  { type: 'filing', many: 'filings', key: 'filedTotal', names: ['Case 1', 'Case 2', 'Case 3'] },
])('honest limits over $many', ({ type, many, key, names }) => {
  const [a = '', b = ''] = names;
  const keys = ['n1', 'n2', 'n3'];
  const values = ['900', '10', '75'];
  const lines = new Map<string, string>(keys.map((id, index) => [id, `${id} | "${type}" | title: "${names[index]}" | id: "${id}x" | ${key}: ${values[index]}`]));
  lines.set('s1', 's1: read of lookup: 3 matches shown · lower bound');
  const held: CheckedText = {
    text: [...lines.values()].join('\n'),
    keys: new Map([...lines.keys()].map((id) => [id, true])),
    lines,
    inexactCounts: [],
    unknownCountKeys: new Set(),
    elementTypes: new Map(keys.map((id) => [id, `entity ${type}`])),
    elementNames: new Map(keys.map((id, index) => [id, [names[index] ?? '', `${id}x`]])),
    propertyKeys: new Map(keys.map((id) => [id, [key]])),
    readKeys: new Set(['s1']),
    readElements: new Map([['s1', keys]]),
    rankedValues: new Map<string, readonly RankedProperty[]>(keys.map((id, index) => [id, [{ key, dataClass: 'number', value: values[index] ?? '' }]])),
  };
  const verdict = (text: string, cites: string[]): string => {
    const judged = judgeSentences([{ text, cites }], held);
    return judged.kept.length === 1 ? 'kept' : (judged.rejected[0]?.reason ?? 'none');
  };

  it.each([
    `The read shows 3 matches, a lower bound, so this ranking does not hold for all of its ${many}.`,
    `This does not hold for every one of the ${many}.`,
    `Here not all ${many} are shown.`,
    `The read does not list all of the ${many}.`,
    `That order doesn't apply to each of the ${many}.`,
  ])('keeps a denial of a claim about all: %s', (text) => {
    expect(verdict(text, ['s1', 'n1'])).toBe('kept');
  });

  it.each([
    `All ${many} are listed.`,
    `The read does not list all of the ${many}, and all ${many} are listed.`,
    `None of the ${many} is hidden.`,
    `It is not hidden that all ${many} are listed.`,
    `${a} is not hidden; all the ${many} are listed.`,
    `This does not cover all as every ${type} is listed.`,
    `This does not cover all because every ${type} is listed.`,
    `This does not cover all while all ${many} are listed.`,
  ])('judges a claim about all that is not denied as before: %s', (text) => {
    expect(verdict(text, ['s1', 'n1'])).toBe('citation');
  });

  it.each([
    `No ${many} are in view, so the largest cannot be named.`,
    `The view holds no relationships, so the largest ${many} cannot be named from it.`,
    `The largest ${key} cannot be identified from the read.`,
    `I cannot identify the largest of the ${many}.`,
    `The smallest can't be determined here.`,
    `The latest ${many} could not be picked out.`,
  ])('keeps a refusal to rank: %s', (text) => {
    expect(verdict(text, ['s1'])).not.toBe('comparison');
  });

  it.each([
    `We cannot name the largest ${key}, as the read shows 3 matches, a lower bound.`,
    `I cannot identify the largest ${key}, but the read lists 3 matches.`,
    `The largest ${key} cannot be named, since the read shows 3 matches, a lower bound.`,
  ])('keeps a refusal that goes on to the count of the read: %s', (text) => {
    expect(verdict(text, ['s1', ...keys])).not.toBe('comparison');
  });

  it.each([
    `The largest ${key} cannot be named, but it is ${b}'s 10.`,
    `The largest ${key} cannot be named: ${b} holds 10.`,
  ])('removes a holder said after a refusal though the read is cited too: %s', (text) => {
    expect(verdict(text, ['s1', ...keys])).toBe('comparison');
  });

  it.each([
    `The smallest cannot be named, but ${b} has the largest ${key}, 10.`,
    `The smallest cannot be named and ${b} has the largest ${key}, 10.`,
    `The smallest cannot be named, so ${b} has the largest ${key}.`,
    `${b} has the largest ${key} and the smallest cannot be named.`,
    `${b} has the largest ${key}, 10, which cannot be named otherwise.`,
    `The largest ${key} of ${b} cannot be doubted.`,
    `The largest, 10, cannot be said to be small.`,
    `We cannot name the largest ${key}, which is ${b}'s 10.`,
    `I cannot tell the largest ${key}: it is ${b}'s 10.`,
    `I cannot identify the largest ${key} except ${b} at 10.`,
    `I cannot name the largest ${key} other than ${b}.`,
    `The largest ${key} cannot be told apart from 10.`,
    `The largest ${key} cannot be named, but it is ${b}'s 10.`,
    `The largest ${key} cannot be named; it is ${b}'s 10.`,
    `The largest ${key} cannot be named, it is ${b}'s 10.`,
    `The largest ${key} cannot be named: ${b} holds 10.`,
    `The largest ${key} cannot be named, and ${b} holds it.`,
    `The largest ${key} cannot be named, so ${b} holds it with 10.`,
  ])('verifies a ranking asserted beside a refusal: %s', (text) => {
    expect(verdict(text, keys)).toBe('comparison');
  });
});
