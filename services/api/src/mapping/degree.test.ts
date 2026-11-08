import { describe, expect, it } from 'vitest';
import { baseSource, fileOf } from '../testing/mapping.js';
import { parseMapping } from './load.js';

const RELATIONSHIPS = [
  { type: 'LINKS', from: 'widget', to: 'gadget' },
  { type: 'KNOWS', from: 'gadget', to: 'widget' },
];
const entity = (degree: unknown, extra: Record<string, unknown> = {}) => [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', ...extra, ...(degree === undefined ? {} : { degree }) },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
];
const load = (degree: unknown, extra: Record<string, unknown> = {}) => parseMapping(fileOf(baseSource({ id: 'demo', entities: entity(degree, extra), relationships: RELATIONSHIPS })), 'neburyx.yaml');
const refusal = (degree: unknown, extra: Record<string, unknown> = {}): string => {
  try {
    load(degree, extra);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'loaded';
};

describe('the degree key of an entity', () => {
  it('loads for a pair the entity has, in either direction', () => {
    expect(() => load([{ type: 'LINKS', direction: 'out', property: 'linksOut' }, { type: 'KNOWS', direction: 'in', property: 'knowsIn' }])).not.toThrow();
  });

  it('refuses a pair the entity does not have, and names the entry', () => {
    expect(refusal([{ type: 'LINKS', direction: 'in', property: 'x' }])).toMatch(/entities\[0\]\.degree\[0\].*names LINKS in, which is not a relationship of entity type widget/s);
    expect(refusal([{ type: 'NOPE', direction: 'out', property: 'x' }])).toContain('names NOPE out');
  });

  it('refuses a pair declared twice', () => {
    expect(refusal([{ type: 'LINKS', direction: 'out', property: 'a' }, { type: 'LINKS', direction: 'out', property: 'b' }])).toMatch(/degree\[1\].*repeats LINKS out/s);
  });

  it.each([
    ['a direction other than out or in', { type: 'LINKS', direction: 'both', property: 'x' }, 'must be one of out, in'],
    ['an empty property', { type: 'LINKS', direction: 'out', property: '' }, 'property'],
    ['a property of only whitespace', { type: 'LINKS', direction: 'out', property: '  ' }, 'whitespace'],
    ['a property with a backtick', { type: 'LINKS', direction: 'out', property: 'a`b' }, 'backtick'],
    ['a property with braces', { type: 'LINKS', direction: 'out', property: 'a{b}' }, 'property'],
    ['an unknown key', { type: 'LINKS', direction: 'out', property: 'x', extra: 1 }, 'extra'],
  ])('refuses %s, naming the entity and the entry', (_name, entry, text) => {
    const message = refusal([entry]);
    expect(message).not.toBe('loaded');
    expect(message).toContain('degree[0]');
    expect(message).toContain(text);
  });

  it("refuses the entity's stable ID property and a personal-data property, without printing a value", () => {
    const stable = refusal([{ type: 'LINKS', direction: 'out', property: 'widgetId' }]);
    expect(stable).toContain('stable ID property of entity type widget');
    expect(stable.replace('widgetId', '').includes('widgetId')).toBe(false);
    const personal = refusal([{ type: 'LINKS', direction: 'out', property: 'secret' }], { pii: ['secret'] });
    expect(personal).toContain('personal-data property of entity type widget');
    expect(personal).not.toContain('secret');
  });

  it('loads a date property and refuses one that is the degree, the stable ID, a personal-data property or not a name', () => {
    expect(() => load([{ type: 'LINKS', direction: 'out', property: 'a', observed_at: 'aAt' }])).not.toThrow();
    expect(refusal([{ type: 'LINKS', direction: 'out', property: 'a', observed_at: 'a' }])).toContain('same property as the degree');
    expect(refusal([{ type: 'LINKS', direction: 'out', property: 'a', observed_at: 'widgetId' }])).toContain('stable ID property of entity type widget');
    expect(refusal([{ type: 'LINKS', direction: 'out', property: 'a', observed_at: 'secret' }], { pii: ['secret'] })).toContain('personal-data property of entity type widget');
    expect(refusal([{ type: 'LINKS', direction: 'out', property: 'a', observed_at: 'a`b' }])).toContain('degree[0]');
    expect(refusal([{ type: 'LINKS', direction: 'out', property: 'a', observed_at: '' }])).toContain('degree[0]');
  });
});
