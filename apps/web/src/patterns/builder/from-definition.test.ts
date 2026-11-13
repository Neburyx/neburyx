import { describe, expect, it } from 'vitest';
import { patternDefinitionSchema, type PatternDefinition } from '@neburyx/contracts';
import { conditionsProfile } from './builder-kit.js';
import { toDefinition } from './model.js';
import { fromDefinition } from './from-definition.js';

const profile = conditionsProfile();
const step = (overrides: Record<string, unknown> = {}) => ({ relationshipTypes: ['k-1'], direction: 'out', arrivesAt: 'c-b', ...overrides });
const VALUES: Readonly<Record<string, unknown>> = {
  text: { kind: 'text', value: 'plain text' },
  number: { kind: 'number', value: 42 },
  boolean: { kind: 'boolean', value: false },
  date: { kind: 'date', value: '2026-03-01' },
  dateTime: { kind: 'dateTime', value: '2026-03-01T10:30:00Z' },
  localDateTime: { kind: 'localDateTime', value: '2026-03-01T10:30:00' },
  time: { kind: 'time', value: '10:30:00Z' },
  localTime: { kind: 'localTime', value: '10:30:00' },
};
const valueOf = (kind: string): unknown => VALUES[kind];
const roundTrip = (definition: PatternDefinition): PatternDefinition | undefined => toDefinition(fromDefinition(definition).draft, profile, false);

describe('the draft of a stored definition', () => {
  const definitions: Array<[string, unknown]> = [
    ['one step with no condition and no window', { anchorType: 'c-a', steps: [step()] }],
    ['an equality on a node, of each kind', { anchorType: 'c-a', steps: [step({ conditions: [{ on: 'neighbor', property: 'b-name', op: 'eq', value: { kind: 'text', value: 'a b' } }, { on: 'neighbor', property: 'b-count', op: 'eq', value: { kind: 'number', value: 12.5 } }, { on: 'neighbor', property: 'b-name', op: 'eq', value: { kind: 'boolean', value: true } }] })] }],
    ['a list of values and a range of dates on the relationship', { anchorType: 'c-a', steps: [step({ conditions: [{ on: 'neighbor', property: 'b-name', op: 'in', values: [{ kind: 'text', value: 'x' }, { kind: 'text', value: 'y' }] }, { on: 'relationship', property: 'q-when', op: 'between', from: { kind: 'date', value: '2026-01-01' }, to: { kind: 'date', value: '2026-02-01' } }] })] }],
    ['a range with one end, of each temporal kind', { anchorType: 'c-a', steps: [step({ conditions: [{ on: 'relationship', property: 'q-when', op: 'between', to: { kind: 'dateTime', value: '2026-01-01T10:00:00Z' } }, { on: 'relationship', property: 'q-size', op: 'between', from: { kind: 'number', value: 1 } }] })] }],
    ['a window of days and a window of dates', { anchorType: 'c-a', steps: [step({ window: { days: 30 } }), step({ relationshipTypes: ['k-3'], arrivesAt: 'c-c', window: undefined })] }],
    ['a window between two dates over several relationship types', { anchorType: 'c-a', steps: [step({ relationshipTypes: ['k-1', 'k-2'], window: { from: '2026-03-01', to: '2026-03-31' } })] }],
    ['an equality of the first four value kinds', { anchorType: 'c-a', steps: [step({ conditions: ['text', 'number', 'boolean', 'date'].map((kind) => ({ on: 'neighbor', property: 'b-name', op: 'eq', value: valueOf(kind) })) })] }],
    ['an equality of the four temporal kinds with a zone or without', { anchorType: 'c-a', steps: [step({ conditions: ['dateTime', 'localDateTime', 'time', 'localTime'].map((kind) => ({ on: 'neighbor', property: 'b-name', op: 'eq', value: valueOf(kind) })) })] }],
    ['a list of text, numbers and dates', { anchorType: 'c-a', steps: [step({ conditions: ['text', 'number', 'date'].map((kind) => ({ on: 'neighbor', property: 'b-name', op: 'in', values: [valueOf(kind), valueOf(kind)] })) })] }],
    ['a list of the four temporal kinds', { anchorType: 'c-a', steps: [step({ conditions: ['dateTime', 'localDateTime', 'time', 'localTime'].map((kind) => ({ on: 'neighbor', property: 'b-name', op: 'in', values: [valueOf(kind), valueOf(kind)] })) })] }],
    ['a range of each temporal and numeric kind, with both ends', { anchorType: 'c-a', steps: [step({ conditions: ['number', 'date', 'dateTime', 'localDateTime', 'time', 'localTime'].map((kind) => ({ on: 'relationship', property: 'q-size', op: 'between', from: valueOf(kind), to: valueOf(kind) })) })] }],
    ['a list of numbers', { anchorType: 'c-a', steps: [step({ conditions: [{ on: 'neighbor', property: 'b-count', op: 'in', values: [{ kind: 'number', value: 1 }, { kind: 'number', value: 2.5 }] }] })] }],
    ['an equality on a date', { anchorType: 'c-a', steps: [step({ conditions: [{ on: 'relationship', property: 'q-when', op: 'eq', value: { kind: 'date', value: '2026-03-01' } }] })] }],
    ['either direction', { anchorType: 'c-a', steps: [step({ direction: 'both' })] }],
    ['each direction', { anchorType: 'c-d', steps: [{ relationshipTypes: ['k-two'], direction: 'in', arrivesAt: 'c-c' }] }],
  ];

  it.each(definitions)('comes back as it was stored, for %s', (_name, input) => {
    const parsed = patternDefinitionSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const back = roundTrip(parsed.data);
    expect(back).toEqual(parsed.data);
    expect(patternDefinitionSchema.safeParse(back).success).toBe(true);
  });

  it('says it cannot show a definition that no longer passes the schema, and gives an empty draft', () => {
    const opened = fromDefinition({ anchorType: 'c-a', steps: [] });
    expect(opened.whole).toBe(false);
    expect(opened.draft.steps).toEqual([]);
    expect(fromDefinition(undefined).whole).toBe(false);
  });
});
