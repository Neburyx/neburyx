import { describe, expect, it } from 'vitest';
import { parseDocument, type Document } from 'yaml';
import { DefinitionError, parseDefinition } from './definition.js';
import { generate } from './generate.js';
import { miniDefinitionText, miniMapping } from './testing/fixture.js';
import { parseLine } from './testing/records.js';

function changed(change: (definition: Document) => void): string {
  const definition = parseDocument(miniDefinitionText);
  change(definition);
  return String(definition);
}

function refusal(text: string): DefinitionError {
  try {
    const definition = parseDefinition(text, miniMapping);
    generate(miniMapping, definition, 1);
  } catch (error) {
    if (error instanceof DefinitionError) return error;
    throw error;
  }
  throw new Error('expected the definition to be refused');
}

describe('a usable definition', () => {
  it('is accepted, and a relationship type mapped without a stable ID needs no identifier rule', () => {
    expect(() => generate(miniMapping, parseDefinition(miniDefinitionText, miniMapping), 1)).not.toThrow();
  });
});

describe('identifier rules', () => {
  const MARKER = 'MARKER_VALUE_NOT_TO_BE_REPEATED';

  it.each([
    ['an entity without its stable ID rule', (d: Document) => d.deleteIn(['entities', 'widget', 'properties', 'widgetId']), 'entities.widget.properties.widgetId'],
    ['an optional entity identifier', (d: Document) => d.setIn(['entities', 'widget', 'properties', 'widgetId', 'missing'], 0.1), 'entities.widget.properties.widgetId'],
    ['a choice as an entity identifier', (d: Document) => d.setIn(['entities', 'widget', 'properties', 'widgetId'], { choice: [MARKER, 'b'] }), 'entities.widget.properties.widgetId'],
    ['a relationship without its stable ID rule', (d: Document) => d.deleteIn(['relationships', 0, 'properties', 'linkId']), 'relationships[0].properties.linkId'],
    ['a random relationship identifier', (d: Document) => d.setIn(['relationships', 0, 'properties', 'linkId'], { int: { min: 1, max: 5 } }), 'relationships[0].properties.linkId'],
    ['an optional relationship identifier', (d: Document) => d.setIn(['relationships', 0, 'properties', 'linkId', 'missing'], 0.2), 'relationships[0].properties.linkId'],
  ])('refuses %s, naming the place', (_name, change, path) => {
    const error = refusal(changed(change));
    expect(error.issues.map((issue) => issue.path)).toContain(path);
    expect(error.message).not.toContain(MARKER);
  });

  describe('across two relationship types that declare a stable ID', () => {
    const both = {
      ...miniMapping,
      relationships: miniMapping.relationships.map((relationship) =>
        relationship.type === 'NEAR' ? { ...relationship, stableId: 'linkId', properties: new Set(['linkId']) } : relationship,
      ),
    };
    const withPrefix = (prefix: string): string =>
      changed((d) => d.setIn(['relationships', 1, 'properties'], { linkId: { sequence: { prefix, width: 5 } } }));

    it('refuses identifiers that collide, naming the relationship type and no value', () => {
      const definition = parseDefinition(withPrefix('L'), both);
      let error: unknown;
      try {
        generate(both, definition, 1);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DefinitionError);
      expect(String(error)).toContain('relationships.NEAR');
      expect(String(error)).not.toContain('L00000');
    });

    it('accepts identifiers that differ between the types', () => {
      expect(() => generate(both, parseDefinition(withPrefix('N'), both), 1)).not.toThrow();
    });
  });
});

describe('names the mapping does not have', () => {
  it.each([
    ['an entity type', (d: Document) => d.setIn(['entities', 'unknown'], { count: 1, properties: {} }), 'entities.unknown'],
    ['a property', (d: Document) => d.setIn(['entities', 'widget', 'properties', 'surprise'], 'x'), 'entities.widget.properties.surprise'],
    ['a relationship type', (d: Document) => d.setIn(['relationships', 0, 'type'], 'MISSING'), 'relationships[0].type'],
    ['an endpoint the definition does not generate', (d: Document) => d.deleteIn(['entities', 'gadget']), 'relationships[0].to'],
    ['a relationship property', (d: Document) => d.setIn(['relationships', 0, 'properties', 'surprise'], 'x'), 'relationships[0].properties.surprise'],
  ])('refuses %s with its place', (_name, change, path) => {
    const error = refusal(changed(change));
    expect(error.issues.map((issue) => issue.path)).toContain(path);
  });
});

describe('malformed rules', () => {
  const MARKER = 'MARKER_BAD_VALUE';
  it.each([
    ['reversed integer bounds', { int: { min: 9, max: 1 } }],
    ['an empty choice', { choice: [] }],
    ['weights that do not match the choices', { choice: ['a', 'b'], weights: [1] }],
    ['a date that is not a calendar day', { date: { from: '2020-02-30', to: '2020-03-01' } }],
    ['reversed dates', { date: { from: '2021-01-01', to: '2020-01-01' } }],
    ['an unknown kind', { surprise: MARKER }],
    ['two kinds in one rule', { int: { min: 1, max: 2 }, decimal: { min: 1, max: 2, places: 1 } }],
    ['a probability outside 0 to 1', { int: { min: 1, max: 2 }, missing: 1.5 }],
  ])('refuses %s, naming the place and repeating no value', (_name, rule) => {
    const error = refusal(changed((d) => d.setIn(['entities', 'gadget', 'properties', 'size'], rule)));
    expect(error.issues.map((issue) => issue.path).some((path) => path.startsWith('entities.gadget.properties.size'))).toBe(true);
    expect(error.message).not.toContain(MARKER);
  });
});

describe('rules that are malformed deeper down', () => {
  it.each([
    ['an unknown key inside a rule body', { sequence: { prefix: 'X', surprise: 1 } }],
    ['an unknown key inside an int body', { int: { min: 1, max: 2, surprise: 1 } }],
    ['a decimal bound that is not a number', { decimal: { min: '.nan', max: 2, places: 1 } }],
    ['a decimal bound that is not finite', { decimal: { min: 0, max: 1e999, places: 1 } }],
    ['a decimal with no value on its step between the bounds', { decimal: { min: 0.006, max: 0.006, places: 2 } }],
    ['bounds with no value on their step, only a rounding error apart', { decimal: { min: 0.10000000001, max: 0.10000000002, places: 1 } }],
    ['an integer beyond 64 bits', { int: { min: '1', max: '9223372036854775808' } }],
    ['an integer bound that is not safe as a number', { int: { min: 1, max: 9007199254740993 } }],
    ['a weight that is not finite', { choice: ['a', 'b'], weights: [1, 1e999] }],
    ['weights on another kind', { int: { min: 1, max: 2 }, weights: [1] }],
    ['a probability that is not a number', { int: { min: 1, max: 2 }, missing: '.nan' }],
    ['a byIndex range with a fractional index', { byIndex: { ranges: [{ from: 0.5, to: 3, rule: 1 }] } }],
    ['a byIndex range with an unknown key', { byIndex: { ranges: [{ from: 0, to: 3, rule: 1, surprise: 1 }] } }],
    ['a byIndex with an unknown key', { byIndex: { surprise: 1 } }],
    ['a cycle that repeats a fractional number of times', { cycle: { values: [1], every: 1.5 } }],
  ])('refuses %s, before anything is exported', (_name, rule) => {
    const error = refusal(changed((d) => d.setIn(['entities', 'gadget', 'properties', 'size'], rule)));
    expect(error.issues.some((issue) => issue.path.startsWith('entities.gadget.properties.size'))).toBe(true);
  });

  it('accepts decimal bounds that sit exactly on a value of their step, such as 0.07 with two places', () => {
    const text = changed((d) => d.setIn(['entities', 'gadget', 'properties', 'weight'], { decimal: { min: 0.07, max: 0.07, places: 2 } }));
    const generated = generate(miniMapping, parseDefinition(text, miniMapping), 1);
    const weights = new Set((generated.files.find((file) => file.type === 'gadget')?.lines ?? []).map((line) => parseLine(line).p.weight));
    expect([...weights]).toEqual([0.07]);
  });

  it('accepts an integer bound written as text beyond the safe range but inside 64 bits', () => {
    expect(() => parseDefinition(changed((d) => d.setIn(['entities', 'gadget', 'properties', 'size'], { int: { min: '9007199254740993', max: '9223372036854775807' } })), miniMapping)).not.toThrow();
  });
});

describe('patterns that cannot be generated', () => {
  const near = (extra: Record<string, unknown>) => ({ type: 'NEAR', from: 'widget', to: 'widget', pattern: 'random', perFrom: { min: 1, max: 1 }, ...extra });
  it.each([
    ['more edges per source than the target range holds', near({ perFrom: { min: 1, max: 6 }, toRange: { start: 0, count: 5 } })],
    ['more edges per target than the source range holds', { type: 'NEAR', from: 'widget', to: 'widget', pattern: 'random', perTo: { min: 1, max: 9 }, fromRange: { start: 0, count: 8 } }],
    ['a supernode that takes sources from outside the source range', near({ fromRange: { start: 0, count: 10 }, supernodes: [{ to: 1, from: { start: 8, count: 5 } }] })],
    ['a supernode that sends to a node that does not exist', near({ supernodes: [{ to: 50, from: { start: 0, count: 2 } }] })],
    ['ring options on a random pattern', near({ groups: 2 })],
    ['random options on a ring pattern', { type: 'NEAR', from: 'widget', to: 'widget', pattern: 'ring', groups: 2, size: 2, fromStart: 0, toStart: 10, perFrom: { min: 1, max: 1 } }],
    ['both perFrom and perTo', near({ perTo: { min: 1, max: 1 } })],
  ])('refuses %s', (_name, block) => {
    expect(() => parseDefinition(changed((d) => d.addIn(['relationships'], block)), miniMapping)).toThrow(DefinitionError);
  });
});

describe('relationship patterns', () => {
  it.each([
    ['a ring past the entities that exist', { type: 'NEAR', from: 'widget', to: 'widget', pattern: 'ring', groups: 20, size: 5, fromStart: 0, toStart: 0 }],
    ['a random pattern with neither perFrom nor perTo', { type: 'NEAR', from: 'widget', to: 'widget', pattern: 'random' }],
    ['a supernode past the entities that exist', { type: 'NEAR', from: 'widget', to: 'widget', pattern: 'random', perFrom: { min: 1, max: 1 }, supernodes: [{ to: 99, from: { start: 0, count: 2 } }] }],
    ['overlapping supernodes', { type: 'NEAR', from: 'widget', to: 'widget', pattern: 'random', perFrom: { min: 1, max: 1 }, supernodes: [{ to: 1, from: { start: 0, count: 5 } }, { to: 2, from: { start: 3, count: 5 } }] }],
  ])('refuses %s', (_name, block) => {
    expect(() => parseDefinition(changed((d) => d.addIn(['relationships'], block)), miniMapping)).toThrow(DefinitionError);
  });
});
