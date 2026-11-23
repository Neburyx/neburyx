import { momentKey } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { removalNoteOf } from './removed-sentences.js';
import { decimalKey, judgeSentences, temporalKey, type CheckedText, type RankedProperty } from './reply-checks.js';

describe('the exact reader of numbers', () => {
  it.each([
    [10, '10'],
    ['0.10', '0.1'],
    ['+007.500', '7.5'],
    ['-0', '0'],
    ['1e3', '1000'],
    ['1.5E-3', '0.0015'],
    ['9007199254740993', '9007199254740993'],
    [0.0000001, '0.0000001'],
    ['.5', '0.5'],
  ])('reads %s as %s', (input, expected) => {
    expect(decimalKey(input)).toBe(expected);
  });

  it.each([['abc'], [''], ['1.2.3'], [Number.NaN], [Number.POSITIVE_INFINITY], ['1e999'], [null], ['.']])('refuses %s', (input) => {
    expect(decimalKey(input)).toBeUndefined();
  });
});

describe('the temporal reader holds to the contract and to the class', () => {
  it.each([
    ['dateTime', '2022-09-10T23:58:00Z'],
    ['dateTime', '2022-09-10T23:58:00.123456789+05:30'],
    ['dateTime', '2022-09-10T18:28:00-00:00'],
    ['localDateTime', '2022-09-10T23:58:00'],
    ['localDateTime', '2022-09-10T23:58:00.5'],
    ['date', '2022-09-10'],
  ] as const)('gives the key of the contract for %s %s', (dataClass, text) => {
    const contract = momentKey(dataClass, text);
    const own = temporalKey(dataClass, text);
    expect(own).toBe(contract === undefined ? undefined : String(contract));
    expect(own).toBeDefined();
  });

  it.each([
    ['date', '2026-02-31'],
    ['date', '2026-02-29'],
    ['date', '2022-09-10T10:00:00'],
    ['localDateTime', '2022-09-10'],
    ['localDateTime', '2022-09-10T25:00:00'],
    ['localDateTime', '2022-09-10T10:00:00Z'],
    ['dateTime', '2022-09-10T10:00:00'],
    ['dateTime', '2022-13-10T10:00:00Z'],
    ['dateTime', '2022-09-10T10:00:00+25:00'],
  ])('refuses %s %s', (dataClass, text) => {
    expect(temporalKey(dataClass, text)).toBeUndefined();
  });

  it('keeps an instant apart from its spelling and a leap day', () => {
    expect(temporalKey('dateTime', '2022-09-10T12:00:00+02:00')).toBe(temporalKey('dateTime', '2022-09-10T10:00:00Z'));
    expect(temporalKey('dateTime', '2022-09-10T10:00:00.000000001Z')).not.toBe(temporalKey('dateTime', '2022-09-10T10:00:00Z'));
    expect(temporalKey('date', '2024-02-29')).toBe('2024-02-29T00:00:00.000000000');
  });

  it('does not depend on the time zone of the process', () => {
    const before = process.env['TZ'];
    process.env['TZ'] = 'Pacific/Kiritimati';
    const far = temporalKey('dateTime', '2022-03-27T01:30:00+01:00');
    process.env['TZ'] = 'America/Los_Angeles';
    const west = temporalKey('dateTime', '2022-03-27T01:30:00+01:00');
    if (before === undefined) delete process.env['TZ'];
    else process.env['TZ'] = before;
    expect(far).toBe(west);
  });
});

describe.each([
  { type: 'widget', other: 'gadget', key: 'amountValue', time: 'seenAt', names: ['Item A', 'Item B', 'Item C'] },
  { type: 'claim', other: 'policy', key: 'claimedAmount', time: 'filedOn', names: ['Case 1', 'Case 2', 'Case 3'] },
])('a ranking over $type elements, with the words of its own mapping', ({ type, other, key, time, names }) => {
  const [a = '', b = '', c = ''] = names;
  const build = (values: readonly (string | undefined)[], over: Partial<CheckedText> = {}): CheckedText => {
    const keys = values.map((_, index) => `n${index + 1}`);
    const lines = new Map<string, string>(keys.map((id, index) => [id, `${id} | "${type}" | title: "${names[index]}" | id: "${id}x" | ${key}: ${values[index] ?? ''}`]));
    lines.set('n9', `n9 | "${other}" | title: "Holder Z" | id: "n9x" | ${key}: 99`);
    lines.set('s1', 's1: read of lookup: 25 matches shown · lower bound');
    const ranked = new Map<string, readonly RankedProperty[]>(keys.map((id, index) => [id, [{ key, dataClass: 'number', ...(values[index] === undefined ? {} : { value: values[index] ?? '' }) }]]));
    return {
      text: [...lines.values()].join('\n'),
      keys: new Map([...lines.keys()].map((id) => [id, true])),
      lines,
      inexactCounts: [],
      unknownCountKeys: new Set(),
      elementTypes: new Map<string, string>([...keys.map((id) => [id, `entity ${type}`] as const), ['n9', `entity ${other}`]]),
      elementNames: new Map<string, readonly string[]>([...keys.map((id, index) => [id, [names[index] ?? '', `${id}x`]] as const), ['n9', ['Holder Z', 'n9x']]]),
      propertyKeys: new Map(keys.map((id) => [id, [key]])),
      readKeys: new Set(['s1']),
      readElements: new Map([['s1', keys]]),
      rankedValues: ranked,
      ...over,
    };
  };
  const verdict = (text: string, cites: string[], over: CheckedText): 'kept' | string => {
    const judged = judgeSentences([{ text, cites }], over);
    return judged.kept.length === 1 ? 'kept' : (judged.rejected[0]?.reason ?? 'none');
  };
  const all = ['n1', 'n2', 'n3'];

  it('keeps the largest and the smallest when every element is cited with a value, whether the element or the figure or both are said', () => {
    const held = build(['10', '2', '7.5']);
    expect(verdict(`${a} has the largest ${key}, 10.`, all, held)).toBe('kept');
    expect(verdict(`${b} has the smallest ${key}, 2.`, all, held)).toBe('kept');
    expect(verdict(`The largest ${key} is 10.`, all, held)).toBe('kept');
    expect(verdict(`${c} has the lowest ${key}.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the highest ${key}.`, all, held)).toBe('kept');
  });

  it('removes the sentence for the wrong element, the wrong figure, a tie, and an uncited, missing or masked value', () => {
    const held = build(['10', '2', '7.5']);
    expect(verdict(`${b} has the largest ${key}, 2.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the largest ${key}, 7.5.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the largest ${key}, 10.`, ['n1', 'n2'], held)).toBe('comparison');
    expect(verdict(`${a} has the largest ${key}, 10.`, all, build(['10', '10.0', '7']))).toBe('comparison');
    expect(verdict(`The largest ${key} is 10.`, all, build(['10', '10.00', '7']))).toBe('comparison');
    expect(verdict(`${a} has the largest ${key}, 10.`, all, build(['10', undefined, '7']))).toBe('comparison');
  });

  it('compares decimals exactly, never through a rounding', () => {
    const big = build(['9007199254740993', '9007199254740992', '1']);
    expect(verdict(`${a} has the largest ${key}, 9007199254740993.`, all, big)).toBe('kept');
    expect(verdict(`${b} has the largest ${key}, 9007199254740992.`, all, big)).toBe('comparison');
    expect(verdict(`${a} has the largest ${key}, 9,007,199,254,740,993.`, all, big)).toBe('kept');
    const small = build(['-0.5', '-0.25', '-3']);
    expect(verdict(`${b} has the largest ${key}, -0.25.`, all, small)).toBe('kept');
    expect(verdict(`${c} has the smallest ${key}, -3.`, all, small)).toBe('kept');
  });

  it('binds the figure of the property, not the figures that happen to match a value', () => {
    const held = build(['10', '2', '7']);
    expect(verdict(`Among 3 ${type}s, ${a} has the largest ${key}, 10.`, all, held)).toBe('kept');
  });

  it('classifies a ranking before it looks for a property: no property, a computed count and a negation are removed, a quantifier is not a ranking', () => {
    const held = build(['10', '2', '7']);
    expect(verdict(`${a} is the largest.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the most ${other}s.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the fewest ${other}s.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the least ${key}.`, all, held)).toBe('comparison');
    expect(verdict(`${b} has the least ${key}, 2.`, all, held)).toBe('kept');
    expect(verdict(`${a} does not have the largest ${key}.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the largest ${key} and the smallest ${key}.`, all, held)).toBe('comparison');
    expect(verdict(`Most of the elements are listed.`, all, held)).toBe('kept');
    expect(verdict(`${a} is listed with at least one ${key}.`, all, held)).toBe('kept');
    expect(verdict(`The elements do not show which ${type} has the largest ${key}.`, ['n9', 's1'], held)).toBe('kept');
  });

  it('does not take a property whose key begins with a ranking word for a ranking, nor a quantity', () => {
    const held = build(['10', '2', '7']);
    const rename = (name: string): CheckedText => {
      const lines = new Map([...held.lines].map(([id, line]) => [id, line.replace(`${key}:`, `${name}:`)]));
      return { ...held, lines, text: [...lines.values()].join('\n'), rankedValues: new Map(all.map((id) => [id, [{ key: name, dataClass: 'number', value: held.rankedValues?.get(id)?.[0]?.value ?? '' }]])) };
    };
    expect(verdict(`${a} has a minimum balance of 10.`, all, rename('minimumBalance'))).toBe('kept');
    expect(verdict(`${a} has a highest_bid of 10.`, all, rename('highest_bid'))).toBe('kept');
    expect(verdict(`${a} has a maximum of 10 ${key}.`, all, held)).toBe('kept');
    expect(verdict(`${a} has the smallest minimum balance, 10.`, all, rename('minimumBalance'))).toBe('comparison');
  });

  it('takes a ranking word joined to another by a hyphen for a ranking, and a name that holds one for none', () => {
    const held = build(['10', '2', '7']);
    expect(verdict(`${b} is the highest-value ${type}, 2.`, all, held)).toBe('comparison');
    expect(verdict(`${a} is the largest-ever ${type}.`, all, held)).toBe('comparison');
    expect(verdict(`${a} is the most-recent ${type}.`, all, held)).toBe('comparison');
    expect(verdict(`${a} is a non-maximum ${type}.`, all, held)).toBe('kept');
  });

  it('removes a ranking over more than was read, and keeps one over those shown that cites them all with the line of a bounded read', () => {
    const held = build(['10', '2', '7']);
    expect(verdict(`${a} has the largest ${key}, 10, in total.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the largest ${key} of those shown, 10.`, [...all, 's1'], held)).toBe('kept');
    expect(verdict(`${a} has the largest ${key} of those shown, 10.`, ['n1', 's1'], held)).toBe('comparison');
  });

  it('takes the property by whole words in order, an exact key first, and a prefix only when no other key starts with it', () => {
    const wide = build(['10', '2', '7']);
    const [firstWord = ''] = (key.match(/\p{Ll}+/gu) ?? []);
    const two = new Map(wide.rankedValues);
    for (const id of all) two.set(id, [...(two.get(id) ?? []), { key: `${key}Other`, dataClass: 'number', value: '1' }]);
    const crowded = { ...wide, rankedValues: two };
    expect(verdict(`${a} has the largest ${key}, 10.`, all, crowded)).toBe('kept');
    expect(verdict(`${a} has the largest ${firstWord}, 10.`, all, crowded)).toBe('comparison');
    expect(verdict(`${a} has the largest ${firstWord}, 10.`, all, wide)).toBe('kept');
  });

  it('refuses a ranking when two cited types carry the property, unless the named element decides the type', () => {
    const held = build(['10', '2', '7']);
    const shared = new Map(held.rankedValues);
    shared.set('n9', [{ key, dataClass: 'number', value: '99' }]);
    const both = { ...held, rankedValues: shared };
    expect(verdict(`The largest ${key} is 99.`, [...all, 'n9'], both)).toBe('comparison');
    expect(verdict(`Holder Z has the largest ${key}, 99.`, [...all, 'n9'], both)).toBe('kept');
  });

  it('does not rank a property of a class that has no order, and does not rank latest over a number', () => {
    const held = build(['10', '2', '7']);
    expect(verdict(`${a} has the latest ${key}, 10.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the earliest ${key}.`, all, held)).toBe('comparison');
  });

  it('verifies one ranking claim in a sentence: a compound ranking, or a second property, is removed', () => {
    const held = build(['10', '2', '7']);
    expect(verdict(`${a} has the largest ${key}, 10, and the highest ${key}.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the largest ${key}, 10, and the smallest ${key}.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the largest ${key}, and ${b} has the smallest ${key}.`, all, held)).toBe('comparison');
  });

  it('reads the figure it claims whole: the first literal after the property, quoted or not, with an exponent, and refuses a malformed one', () => {
    const held = build(['10', '2', '7']);
    expect(verdict(`${a} has the largest ${key}, "2".`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the largest ${key}, with the value reported here being 2.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the largest ${key}, with the value reported here being 10.`, all, held)).toBe('kept');
    expect(verdict(`${a} has the largest ${key}, 1.2.3.`, all, held)).toBe('number');
  });

  it('removes a ranking over the whole source, the database or the data, and keeps one of those shown', () => {
    const held = build(['10', '2', '7']);
    expect(verdict(`${a} has the largest ${key}, 10, in the entire database.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the largest ${key}, 10, across the whole source.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the largest ${key}, 10, anywhere.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the largest ${key} of those shown, 10.`, all, held)).toBe('kept');
  });

  it('judges a statement that the elements do not show by its own clause: an unrelated property does not turn it into a ranking, a positive ranking beside it is still checked', () => {
    const held = build(['10', '2', '7']);
    expect(verdict(`The elements do not show which ${type} has the largest score.`, ['n1', 's1'], held)).toBe('kept');
    expect(verdict(`The elements do not show which ${type} has the largest ${key}.`, ['n9', 's1'], held)).toBe('kept');
    expect(verdict(`The elements do not show who sent it, and ${b} has the largest ${key}, 2.`, [...all, 's1'], held)).toBe('comparison');
  });

  it('writes at least with any white space, and refuses a negation only before the ranking word', () => {
    const held = build(['10', '2', '7']);
    expect(verdict(`${a} is listed with at  least one ${key}.`, all, held)).toBe('kept');
    expect(verdict(`${a} has the largest ${key}, 10, which is not in doubt.`, all, held)).toBe('kept');
    expect(verdict(`${a} is not the one with the largest ${key}.`, all, held)).toBe('comparison');
  });

  it('counts every property of the cited elements when it names one by a prefix, those with no value and those that cannot be ranked too', () => {
    const wide = build(['10', '2', '7']);
    const [firstWord = ''] = (key.match(/\p{Ll}+/gu) ?? []);
    const ranked = new Map(wide.rankedValues);
    for (const id of all) ranked.set(id, [...(ranked.get(id) ?? []), { key: `${key}Note`, dataClass: 'text' }]);
    expect(verdict(`${a} has the largest ${firstWord}, 10.`, all, { ...wide, rankedValues: ranked })).toBe('comparison');
    expect(verdict(`${a} has the largest ${key}, 10.`, all, { ...wide, rankedValues: ranked })).toBe('kept');
  });

  it('names a property by whole words in order whatever is between the words: digits, hyphens and keys of many words', () => {
    const held = build(['10', '2', '7']);
    const rename = (name: string): CheckedText => {
      const lines = new Map([...held.lines].map(([id, line]) => [id, line.replace(`${key}:`, `${name}:`)]));
      return { ...held, lines, text: [...lines.values()].join('\n'), rankedValues: new Map(all.map((id) => [id, [{ key: name, dataClass: 'number', value: held.rankedValues?.get(id)?.[0]?.value ?? '' }]])) };
    };
    expect(verdict(`${a} has the largest amount2, 10.`, all, rename('amount2'))).toBe('kept');
    expect(verdict(`${a} has the largest amount 2, 10.`, all, rename('amount2'))).toBe('kept');
    expect(verdict(`${a} has the largest total-paid-in-last-year amount, 10.`, all, rename('totalPaidInLastYearAmount'))).toBe('kept');
    expect(verdict(`${a} has the largest total paid in last year amount, 10.`, all, rename('total_paid_in_last_year_amount'))).toBe('kept');
    expect(verdict(`${a} has the largest paid total, 10.`, all, rename('totalPaid'))).toBe('comparison');
  });

  it('removes a ranking of a computed figure after any ranking word, also when the number it claims is on a cited line', () => {
    const held = build(['10', '2', '7']);
    for (const word of ['largest', 'biggest', 'greatest', 'highest', 'maximum', 'smallest', 'lowest', 'minimum', 'fewest', 'least']) {
      expect(verdict(`${a} has the ${word} total of 10.`, all, held), word).toBe('comparison');
      expect(verdict(`${a} has the ${word} number of ${other}s, 7.`, all, held), word).toBe('comparison');
    }
    expect(verdict(`${a} has the most ${other}s, 7.`, all, held)).toBe('comparison');
    expect(verdict(`${a} has the greatest share, 10 percent.`, all, held)).toBe('comparison');
  });

  it('puts a ranking that also holds a number no cited line holds under the reason number, and one that states an unknown count under count', () => {
    const held = build(['10', '2', '7']);
    expect(verdict(`${a} has the largest ${key}, 10, of 99 ${type}s.`, all, held)).toBe('number');
    const unknown = { ...held, unknownCountKeys: new Set(['s1']) };
    expect(verdict(`${a} has the largest ${key}, 10, of 3 ${type}s.`, [...all, 's1'], unknown)).toBe('count');
  });

  describe('over times', () => {
    const times = (literals: readonly string[], dataClass: 'dateTime' | 'date' | 'localDateTime'): CheckedText => {
      const held = build(['1', '2', '3']);
      const ranked = new Map(held.rankedValues);
      const lines = new Map(held.lines);
      ['n1', 'n2', 'n3'].forEach((id, index) => {
        ranked.set(id, [{ key: time, dataClass, value: temporalKey(dataClass, literals[index] ?? '') ?? '' }]);
        lines.set(id, `${id} | "${type}" | title: "${names[index]}" | id: "${id}x" | ${time}: "${literals[index]}"`);
      });
      return { ...held, rankedValues: ranked, lines, text: [...lines.values()].join('\n') };
    };
    it('orders an instant, a local time and a day by their own meaning, and ties two spellings of one instant', () => {
      const instants = times(['2022-09-10T12:00:00+02:00', '2022-09-10T09:00:00Z', '2022-09-10T10:00:00.000000001Z'], 'dateTime');
      expect(verdict(`${a} has the earliest ${time}.`, all, instants)).toBe('comparison');
      expect(verdict(`${b} has the earliest ${time}, 2022-09-10T09:00:00Z.`, all, instants)).toBe('kept');
      expect(verdict(`${c} has the latest ${time}, 2022-09-10T10:00:00.000000001Z.`, all, instants)).toBe('kept');
      const days = times(['2022-09-10', '2021-01-02', '2023-12-31'], 'date');
      expect(verdict(`${c} has the latest ${time}, 2023-12-31.`, all, days)).toBe('kept');
      expect(verdict(`${b} has the earliest ${time}, 2021-01-02.`, all, days)).toBe('kept');
      expect(verdict(`${b} has the earliest ${time}, 2021-02-31.`, all, days)).toBe('comparison');
      const local = times(['2022-09-10T10:00:00', '2022-09-10T09:59:59.9', '2022-09-11T00:00:00'], 'localDateTime');
      expect(verdict(`${b} has the earliest ${time}, 2022-09-10T09:59:59.9.`, all, local)).toBe('kept');
    });

    it('ranks the extreme of instants by value alone, and ties two spellings of one instant even when no element is named', () => {
      const instants = times(['2022-09-10T12:00:00+02:00', '2022-09-10T09:00:00Z', '2022-09-10T10:00:00.000000001Z'], 'dateTime');
      expect(verdict(`The earliest ${time} is 2022-09-10T09:00:00Z.`, all, instants)).toBe('kept');
      expect(verdict(`The latest ${time} is 2022-09-10T10:00:00.000000001Z.`, all, instants)).toBe('kept');
      const tied = times(['2022-09-10T12:00:00+02:00', '2022-09-10T10:00:00Z', '2022-09-10T10:00:00.000000001Z'], 'dateTime');
      expect(verdict(`The earliest ${time} is 2022-09-10T10:00:00Z.`, all, tied)).toBe('comparison');
      expect(verdict(`The earliest ${time} is 2022-09-10T10:00:00.`, all, instants)).toBe('comparison');
    });

    it('reads a claimed instant written with a zone in brackets whole', () => {
      const zone = times(['2022-09-10T10:00:00Z[UTC]', '2022-09-09T10:00:00Z[UTC]', '2022-09-08T10:00:00Z[UTC]'], 'dateTime');
      expect(verdict(`The latest ${time} is 2022-09-10T10:00:00Z[UTC].`, all, zone)).toBe('kept');
      expect(verdict(`The latest ${time} is 2022-09-09T10:00:00Z[UTC].`, all, zone)).toBe('comparison');
    });

    it('does not rank mixed classes', () => {
      const base = times(['2022-09-10', '2021-01-02', '2023-12-31'], 'date');
      const ranked = new Map(base.rankedValues);
      ranked.set('n3', [{ key: time, dataClass: 'dateTime', value: temporalKey('dateTime', '2023-12-31T00:00:00Z') ?? '' }]);
      const mixed = { ...base, rankedValues: ranked };
      expect(verdict(`${b} has the earliest ${time}.`, all, mixed)).toBe('comparison');
    });
  });
});

describe('what the model is told of a removed ranking', () => {
  it('says that the ranking cannot be verified against the cited values, and holds no value and no corrected answer', () => {
    const note = removalNoteOf([{ text: 'T is the largest.', reason: 'comparison' }]);
    expect(note).toBe('Removed: "T is the largest." (it compares elements that the lines it cites do not all show, or ranks them (the largest, the smallest, the latest, the earliest, the most or the fewest) in a way that cannot be verified against the cited values: a tie, a value that is missing, masked or of another kind, an element that was not cited, or a property that is not named once).');
    expect(note).not.toMatch(/\d/u);
  });
});
