import { describe, expect, it } from 'vitest';
import type { SentValue } from '../case-summary/assemble.js';
import { V } from '../testing/assistant-rig.js';
import { classifyItem, type ClassifyContext } from './sensitive-items.js';

const value = (key: string, text: string, masked = false): SentValue => ({ key, text, masked });

/** The same behaviour over the suites' vocabulary (either pack, by the pack run) and over mappings with other names: the classifier reads keys and values and nothing else. */
describe.each([
  { name: 'the vocabulary of the suites (a pack when one is named)', type: V.anchor, secret: 'covert_a', plain: 'open_b', other: V.other },
  { name: 'a mapping with other names', type: 'thing_one', secret: 'code_x', plain: 'note', other: 'thing_two' },
  { name: 'a third mapping with other names', type: 'gizmo', secret: 'hidden_k', plain: 'visible_k', other: 'sprocket' },
])('an item classified over $name', ({ type, secret, plain, other }) => {
  const make = (over: Partial<ClassifyContext> = {}, values: Record<string, SentValue[]> = {}): ClassifyContext => {
    const held: Record<string, SentValue[]> = { n1: [value('(title)', 'Item One'), value(secret, 'Jordan Lee'), value(plain, 'gold')], n2: [value('(title)', 'Item Two'), value(secret, 'Maria Gomez'), value(plain, 'gold')], n3: [value('(title)', 'Item Three'), value(secret, '555-0100 2000'), value(plain, 'basic')], e1: [], ...values };
    return {
      sentValues: new Map(Object.entries(held)),
      sent: Object.keys(held),
      typeOf: (key) => (key.startsWith('n') ? type : key.startsWith('m') ? other : undefined),
      sensitiveKeys: new Map([[type, [secret]]]),
      ...over,
    };
  };

  it('is frozen when no sensitive value occurs in it, and the plain value of the same element is no reason to bind', () => {
    expect(classifyItem('Item One has the segment gold.', ['n1'], make())).toEqual({ form: 'frozen' });
    expect(classifyItem('Two items share the same note.', [], make())).toEqual({ form: 'frozen' });
  });

  it('is bound when each sensitive value is the whole value of one property of one cited element, with the spans', () => {
    const text = 'The holder is Jordan Lee, and Maria Gomez too.';
    const classified = classifyItem(text, ['n1', 'n2'], make());
    expect(classified).toEqual({ form: 'bound', spans: [{ start: 14, end: 24, element: 'n1', property: secret }, { start: 30, end: 41, element: 'n2', property: secret }] });
    expect(text.slice(14, 24)).toBe('Jordan Lee');
  });

  it('is unbound for a word of a sensitive value, for a number written with other separators, and for a sensitive value beside a bound one it does not hold whole', () => {
    expect(classifyItem('Jordan is listed.', ['n1'], make())).toEqual({ form: 'unbound' });
    expect(classifyItem('The number is 5550100 2000.', ['n3'], make())).toEqual({ form: 'unbound' });
    expect(classifyItem('The number is 555.0100.2000.', ['n3'], make())).toEqual({ form: 'unbound' });
    expect(classifyItem('Jordan Lee and Maria are listed.', ['n1', 'n2'], make())).toEqual({ form: 'unbound' });
    expect(classifyItem('The holder is 555-0100 2000.', ['n3'], make())).toEqual({ form: 'bound', spans: [{ start: 14, end: 27, element: 'n3', property: secret }] });
  });

  it('is unbound for a value of an element the item does not cite, and for a value that two elements or two properties of one element share', () => {
    expect(classifyItem('The holder is Maria Gomez.', ['n1'], make())).toEqual({ form: 'unbound' });
    expect(classifyItem('The holder is Jordan Lee.', ['n1', 'n2'], make({}, { n2: [value(secret, 'Jordan Lee')] }))).toEqual({ form: 'unbound' });
    expect(classifyItem('The holder is Jordan Lee.', ['n1'], make({ sensitiveKeys: new Map([[type, [secret, plain]]]) }, { n1: [value(secret, 'Jordan Lee'), value(plain, 'Jordan Lee')] }))).toEqual({ form: 'unbound' });
  });

  it('is unbound, never frozen, when the metadata is not there or the provenance is incomplete', () => {
    expect(classifyItem('Item One is listed.', ['n1'], make({ sensitiveKeys: undefined }))).toEqual({ form: 'unbound' });
    expect(classifyItem('Item One is listed.', ['n1'], make({ sentValues: undefined }))).toEqual({ form: 'unbound' });
    expect(classifyItem('Item One is listed.', ['n1'], make({ sent: ['n1', 'n2', 'n9'] }))).toEqual({ form: 'unbound' });
    expect(classifyItem('Item One is listed.', ['n9'], make())).toEqual({ form: 'unbound' });
  });

  it('treats the title as sensitive where the mapping says so, leaves a masked text alone, and knows no relationship or type without keys as sensitive', () => {
    const titled = make({ sensitiveKeys: new Map([[type, ['(title)']]]) });
    expect(classifyItem('Item One is listed.', ['n1'], titled)).toEqual({ form: 'bound', spans: [{ start: 0, end: 8, element: 'n1', property: '(title)' }] });
    expect(classifyItem('Item One is listed.', [], titled)).toEqual({ form: 'unbound' });
    expect(classifyItem('The holder is ******.', ['n1'], make({}, { n1: [value(secret, '******', true), value('(title)', 'Item One')] }))).toEqual({ form: 'frozen' });
    expect(classifyItem('The holder is Zed Quux.', ['m1'], make({}, { m1: [value(secret, 'Zed Quux')] }))).toEqual({ form: 'frozen' });
  });

  it('keeps the case of a name and its offsets, and refuses a fold that would move them', () => {
    expect(classifyItem('JORDAN LEE is listed.', ['n1'], make())).toEqual({ form: 'bound', spans: [{ start: 0, end: 10, element: 'n1', property: secret }] });
    expect(classifyItem('İ is listed.', ['n1'], make())).toEqual({ form: 'unbound' });
  });
});
