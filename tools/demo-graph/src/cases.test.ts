import { describe, expect, it } from 'vitest';
import { parseDocument, type Document } from 'yaml';
import { CasesError, namedNodes, parseCases } from './cases.js';
import { miniDefinition, miniMapping } from './testing/fixture.js';

const GOOD = `
preset:
  entity: { type: widget, id: W0001 }
  case_ref: "REF-DEMO-1"
cases:
  - id: widget-gadgets
    title: A widget and its gadgets
    expect:
      - { node: { type: widget, id: W0001 }, via: HAS, direction: out, count: 2 }
      - { node: { type: gadget, id: G000 }, via: HAS, direction: in, ids: [W0001, W0002] }
      - { node: { type: gadget, id: G000 }, property: isCommon, equals: true }
`;

const MARKER = 'MARKER_VALUE_NOT_TO_BE_REPEATED';

function changed(change: (document: Document) => void): string {
  const document = parseDocument(GOOD);
  change(document);
  return String(document);
}

function refusal(text: string): CasesError {
  try {
    parseCases(text, miniMapping, miniDefinition);
  } catch (error) {
    if (error instanceof CasesError) return error;
    throw error;
  }
  throw new Error('expected the cases to be refused');
}

const first = ['cases', 0, 'expect', 0] as const;
const second = ['cases', 0, 'expect', 1] as const;
const third = ['cases', 0, 'expect', 2] as const;

describe('a refused cases file', () => {
  it.each([
    ['an unknown key', (d: Document) => d.setIn([...first, 'extra'], 1), 'cases[0].expect[0]'],
    ['an entity type the mapping does not have', (d: Document) => d.setIn([...first, 'node', 'type'], MARKER), 'case widget-gadgets, expectation 1'],
    ['a relationship type the mapping does not have', (d: Document) => d.setIn([...first, 'via'], MARKER), 'case widget-gadgets, expectation 1'],
    ['a relationship type that does not touch the node in that direction', (d: Document) => d.setIn(second, { node: { type: 'gadget', id: 'G000' }, via: 'HAS', direction: 'out', count: 1 }), 'case widget-gadgets, expectation 2'],
    ['a property the definition does not generate', (d: Document) => d.setIn([...third, 'property'], MARKER), 'case widget-gadgets, expectation 3'],
    ['ids and a count together', (d: Document) => d.setIn([...first, 'ids'], ['W0001']), 'case widget-gadgets, expectation 1'],
    ['neither ids nor a count', (d: Document) => d.deleteIn([...first, 'count']), 'case widget-gadgets, expectation 1'],
    ['a stable ID listed twice', (d: Document) => d.setIn([...second, 'ids'], ['W0001', 'W0001']), 'case widget-gadgets, expectation 2'],
    ['more than 100 stable IDs', (d: Document) => d.setIn([...second, 'ids'], Array.from({ length: 101 }, (_unused, index) => `W${String(index).padStart(4, '0')}`)), 'cases[0].expect[1].ids'],
    ['a property expectation that also gives ids', (d: Document) => d.setIn([...third, 'ids'], ['W0001']), 'case widget-gadgets, expectation 3'],
    ['a property expectation that gives a count', (d: Document) => d.setIn([...third, 'count'], 3), 'case widget-gadgets, expectation 3'],
    ['a property without a value to equal', (d: Document) => d.deleteIn([...third, 'equals']), 'case widget-gadgets, expectation 3'],
    ['a value to equal without a property', (d: Document) => d.setIn(first, { node: { type: 'widget', id: 'W0001' }, equals: true }), 'case widget-gadgets, expectation 1'],
    ['a count that is not a whole number', (d: Document) => d.setIn([...first, 'count'], 1.5), 'cases[0].expect[0].count'],
    ['a case ID that is not lower-case words', (d: Document) => d.setIn(['cases', 0, 'id'], 'Not Allowed'), 'cases[0].id'],
    ['no preset', (d: Document) => d.delete('preset'), 'preset'],
    ['two presets', (d: Document) => d.set('preset', [d.get('preset'), d.get('preset')]), 'preset'],
    ['a preset entity type the mapping does not have', (d: Document) => d.setIn(['preset', 'entity', 'type'], MARKER), 'preset'],
    ['an empty case reference', (d: Document) => d.setIn(['preset', 'case_ref'], ''), 'preset.case_ref'],
    ['a case reference of 101 code points', (d: Document) => d.setIn(['preset', 'case_ref'], '😀'.repeat(101)), 'preset.case_ref'],
    ['a case reference with a control character', (d: Document) => d.setIn(['preset', 'case_ref'], 'REF\u0007DEMO'), 'preset.case_ref'],
    ['an entity ID of 201 code points', (d: Document) => d.setIn(['preset', 'entity', 'id'], '😀'.repeat(201)), 'preset.entity.id'],
    ['an entity type with an unpaired surrogate', (d: Document) => d.setIn(['preset', 'entity', 'type'], 'T\uD800'), 'preset.entity.type'],
    ['a case reference with an unpaired surrogate', (d: Document) => d.setIn(['preset', 'case_ref'], 'REF\uDC00'), 'preset.case_ref'],
    ['a case with no expectation', (d: Document) => d.setIn(['cases', 0, 'expect'], []), 'cases[0].expect'],
  ])('%s names its place and repeats no value', (_name, change, place) => {
    const error = refusal(changed(change));
    expect(error.message).toContain(place);
    expect(error.message).not.toContain(MARKER);
    expect(error.message).not.toContain('W0001');
    expect(error.message).not.toContain('G000');
  });

  it('refuses a repeated case ID', () => {
    const text = changed((d) => d.addIn(['cases'], d.getIn(['cases', 0])));
    expect(refusal(text).message).toContain('case widget-gadgets: repeats the ID of another case');
  });

  it('refuses text that is not YAML and an alias that cannot be resolved, without echoing it', () => {
    expect(refusal(`cases: [${MARKER}`).message).not.toContain(MARKER);
    expect(refusal(`cases: *${MARKER}`).message).not.toContain(MARKER);
  });
});

describe('a usable cases file', () => {
  it('is read with the neighbor type taken from the relationship and every named node listed', () => {
    const cases = parseCases(GOOD, miniMapping, miniDefinition);
    expect(cases.cases).toHaveLength(1);
    const [out, into, property] = cases.cases[0]?.expect ?? [];
    expect(out).toMatchObject({ kind: 'neighbors', neighbor: 'gadget', direction: 'out', answer: { kind: 'count', count: 2 } });
    expect(into).toMatchObject({ kind: 'neighbors', neighbor: 'widget', direction: 'in', answer: { kind: 'ids', ids: ['W0001', 'W0002'] } });
    expect(property).toMatchObject({ kind: 'property', property: 'isCommon', equals: true });
    expect(namedNodes(cases).map((entry) => `${entry.place}: ${entry.node.type} ${entry.node.id}`)).toEqual([
      'preset: widget W0001',
      'case widget-gadgets, expectation 1: widget W0001',
      'case widget-gadgets, expectation 2: gadget G000',
      'case widget-gadgets, expectation 2: widget W0001',
      'case widget-gadgets, expectation 2: widget W0002',
      'case widget-gadgets, expectation 3: gadget G000',
    ]);
  });

  it('reads the preset and accepts a case reference of exactly 100 code points', () => {
    expect(parseCases(GOOD, miniMapping, miniDefinition).preset).toEqual({ entity: { type: 'widget', id: 'W0001' }, caseRef: 'REF-DEMO-1' });
    const text = changed((d) => d.setIn(['preset', 'case_ref'], '😀'.repeat(100)));
    expect([...parseCases(text, miniMapping, miniDefinition).preset.caseRef]).toHaveLength(100);
  });

  it('accepts exactly 100 stable IDs', () => {
    const text = changed((d) => d.setIn([...second, 'ids'], Array.from({ length: 100 }, (_unused, index) => `W${String(index).padStart(4, '0')}`)));
    expect(() => parseCases(text, miniMapping, miniDefinition)).not.toThrow();
  });
});
