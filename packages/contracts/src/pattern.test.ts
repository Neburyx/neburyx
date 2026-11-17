import { describe, expect, it } from 'vitest';
import { MAX_FILTER_TEXT, MAX_FILTER_VALUES, MAX_FILTERS } from './expand.js';
import { MAX_PATTERN_PROBLEMS, PATTERN_LIMITS, PATTERN_PROBLEM_CODES, PATTERN_WITHIN_MAX_HOURS, withinMinutesOf, patternValidateRequestSchema, patternPreviewResponseSchema, patternDefinitionSchema, patternProblemsOf, patternValidateResponseSchema } from './pattern.js';

const step = (extra: Record<string, unknown> = {}) => ({ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', ...extra });
const definition = (extra: Record<string, unknown> = {}) => ({ anchorType: 'maker', steps: [step()], ...extra });
const eq = (property = 'grade', value = 'a') => ({ op: 'eq', on: 'neighbor', property, value: { kind: 'text', value } });
const problems = (value: unknown) => patternProblemsOf(value);

describe('a pattern definition', () => {
  it('parses a one-step pattern, a list of relationship types, each direction, conditions and a window', () => {
    expect(patternDefinitionSchema.safeParse(definition()).success).toBe(true);
    for (const direction of ['out', 'in', 'both']) expect(patternDefinitionSchema.safeParse(definition({ steps: [step({ direction })] })).success).toBe(true);
    const rich = definition({
      steps: [
        step({ relationshipTypes: ['LINKS', 'KNOWS'], conditions: [eq(), { op: 'in', on: 'relationship', property: 'kind', values: [{ kind: 'text', value: 'a' }, { kind: 'text', value: 'b' }] }, { op: 'between', on: 'neighbor', property: 'score', from: { kind: 'number', value: 1 } }], window: { days: 30 } }),
        step({ arrivesAt: 'shop', window: { from: '2026-01-01', to: '2026-01-31' } }),
      ],
    });
    expect(problems(rich)).toEqual([]);
    expect(patternDefinitionSchema.safeParse(rich).success).toBe(true);
  });

  it('holds one to four steps and one to six distinct non-empty names of at most the length of a condition text', () => {
    expect(problems(definition({ steps: [] }))).toEqual([{ path: ['steps'], code: 'too-few' }]);
    expect(problems(definition({ steps: Array.from({ length: 4 }, () => step()) }))).toEqual([]);
    expect(problems(definition({ steps: Array.from({ length: 5 }, () => step()) }))).toEqual([{ path: ['steps'], code: 'too-many' }]);
    expect(problems(definition({ steps: [step({ relationshipTypes: [] })] }))).toEqual([{ path: ['steps', 0, 'relationshipTypes'], code: 'too-few' }]);
    expect(problems(definition({ steps: [step({ relationshipTypes: ['A', 'B', 'C', 'D', 'E', 'F'] })] }))).toEqual([]);
    expect(problems(definition({ steps: [step({ relationshipTypes: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] })] }))).toEqual([{ path: ['steps', 0, 'relationshipTypes'], code: 'too-many' }]);
    expect(problems(definition({ steps: [step({ relationshipTypes: ['LINKS', 'LINKS'] })] }))).toEqual([{ path: ['steps', 0, 'relationshipTypes', 1], code: 'bad-value' }]);
    expect(problems(definition({ anchorType: '' }))).toEqual([{ path: ['anchorType'], code: 'bad-value' }]);
    expect(problems(definition({ anchorType: 'a'.repeat(MAX_FILTER_TEXT) }))).toEqual([]);
    expect(problems(definition({ anchorType: 'a'.repeat(MAX_FILTER_TEXT + 1) }))).toEqual([{ path: ['anchorType'], code: 'bad-value' }]);
  });

  it('refuses a direction that is not out, in or both, a missing member and a member of the wrong type', () => {
    expect(problems(definition({ steps: [step({ direction: 'up' })] }))).toEqual([{ path: ['steps', 0, 'direction'], code: 'bad-value' }]);
    const { arrivesAt: _arrivesAt, ...without } = step();
    expect(problems(definition({ steps: [without] }))).toEqual([{ path: ['steps', 0, 'arrivesAt'], code: 'missing' }]);
    expect(problems(definition({ steps: [step({ arrivesAt: 7 })] }))).toEqual([{ path: ['steps', 0, 'arrivesAt'], code: 'wrong-type' }]);
    expect(problems({ steps: [step()] })).toEqual([{ path: ['anchorType'], code: 'missing' }]);
    expect(problems(null)).toEqual([{ path: [], code: 'wrong-type' }]);
    expect(problems([])).toEqual([{ path: [], code: 'wrong-type' }]);
    expect(problems('x')).toEqual([{ path: [], code: 'wrong-type' }]);
  });

  it('reuses the conditions of Expand, the kind rules among them, and checks a condition against the branch its op names', () => {
    expect(problems(definition({ steps: [step({ conditions: [{ op: 'in', on: 'neighbor', property: 'p', values: [{ kind: 'text', value: 'a' }, { kind: 'number', value: 1 }] }] })] }))).toEqual([{ path: ['steps', 0, 'conditions', 0], code: 'bad-shape' }]);
    expect(problems(definition({ steps: [step({ conditions: [{ op: 'between', on: 'neighbor', property: 'p' }] })] }))).toEqual([{ path: ['steps', 0, 'conditions', 0], code: 'bad-shape' }]);
    expect(problems(definition({ steps: [step({ conditions: [{ op: 'between', on: 'neighbor', property: 'p', from: { kind: 'boolean', value: true } }] })] }))).toEqual([{ path: ['steps', 0, 'conditions', 0], code: 'bad-shape' }]);
    expect(problems(definition({ steps: [step({ conditions: [{ op: 'like', on: 'neighbor', property: 'p', value: { kind: 'text', value: 'a' } }] })] }))).toEqual([{ path: ['steps', 0, 'conditions', 0, 'op'], code: 'bad-value' }]);
    expect(problems(definition({ steps: [step({ conditions: [{ on: 'neighbor', property: 'p' }] })] }))).toEqual([{ path: ['steps', 0, 'conditions', 0, 'op'], code: 'missing' }]);
    expect(problems(definition({ steps: [step({ conditions: ['x'] })] }))).toEqual([{ path: ['steps', 0, 'conditions', 0], code: 'wrong-type' }]);
    expect(problems(definition({ steps: [step({ conditions: [{ op: 'eq', on: 'anchor', property: 'p', value: { kind: 'text', value: 'a' } }] })] }))).toEqual([{ path: ['steps', 0, 'conditions', 0, 'on'], code: 'bad-value' }]);
    expect(problems(definition({ steps: [step({ conditions: [{ op: 'eq', on: 'neighbor', property: 'p', value: { kind: 'date', value: '2026-02-30' } }] })] }))).toEqual([{ path: ['steps', 0, 'conditions', 0, 'value', 'value'], code: 'bad-value' }]);
  });

  it('refuses a key the schema does not name at every level, and the problem names the object that holds it, never the key', () => {
    const sentinel = 'SENTINEL-KEY';
    expect(problems({ ...definition(), [sentinel]: 1 })).toEqual([{ path: [], code: 'unknown-key' }]);
    expect(problems(definition({ steps: [{ ...step(), [sentinel]: 1 }] }))).toEqual([{ path: ['steps', 0], code: 'unknown-key' }]);
    expect(problems(definition({ steps: [step({ conditions: [{ ...eq(), [sentinel]: 1 }] })] }))).toEqual([{ path: ['steps', 0, 'conditions', 0], code: 'unknown-key' }]);
    expect(problems(definition({ steps: [step({ window: { days: 3, [sentinel]: 1 } })] }))).toEqual([{ path: ['steps', 0, 'window'], code: 'unknown-key' }]);
    expect(problems(definition({ steps: [step({ window: { from: '2026-01-01', to: '2026-01-31', [sentinel]: 1 } })] }))).toEqual([{ path: ['steps', 0, 'window'], code: 'unknown-key' }]);
    expect(JSON.stringify(problems({ ...definition(), [sentinel]: 1 }))).not.toContain(sentinel);
  });

  it('refuses a window that is not days from 1 to 3650 or a range of calendar dates in order, at its own place', () => {
    for (const window of [{ days: 0 }, { days: 3651 }, { days: 1.5 }, { days: '3' }]) expect(problems(definition({ steps: [step({ window })] })).map((problem) => problem.path.join('.')), JSON.stringify(window)).toEqual(['steps.0.window.days']);
    expect(problems(definition({ steps: [step({ window: { from: '2026-02-30', to: '2026-03-01' } })] }))).toEqual([{ path: ['steps', 0, 'window'], code: 'bad-value' }]);
    expect(problems(definition({ steps: [step({ window: { from: '2026-03-02', to: '2026-03-01' } })] }))).toEqual([{ path: ['steps', 0, 'window'], code: 'bad-value' }]);
    expect(problems(definition({ steps: [step({ window: { from: '2026-03-01' } })] }))).toEqual([{ path: ['steps', 0, 'window', 'to'], code: 'missing' }]);
    expect(problems(definition({ steps: [step({ window: 'last week' })] }))).toEqual([{ path: ['steps', 0, 'window'], code: 'wrong-type' }]);
    expect(problems(definition({ steps: [step({ window: { days: 3, from: '2026-03-01', to: '2026-03-02' } })] }))).toEqual([{ path: ['steps', 0, 'window'], code: 'unknown-key' }]);
  });

  it('has no field that holds query text, and none for an entity: a key for one is an unknown key', () => {
    for (const key of ['query', 'cypher', 'where', 'text', 'statement', 'stableId', 'ref', 'anchor']) {
      expect(problems({ ...definition(), [key]: 'MATCH (n) RETURN n' }), key).toEqual([{ path: [], code: 'unknown-key' }]);
      expect(problems(definition({ steps: [step({ [key]: 'MATCH (n) RETURN n' })] })), key).toEqual([{ path: ['steps', 0], code: 'unknown-key' }]);
    }
  });

  it('refuses the counts above the caps with too-many at the path of the list: conditions per element, values of an in, conditions in all', () => {
    const conditions = (count: number, on = 'neighbor') => Array.from({ length: count }, (_, index) => ({ ...eq(`p${index}`), on }));
    expect(problems(definition({ steps: [step({ conditions: conditions(MAX_FILTERS) })] }))).toEqual([]);
    expect(problems(definition({ steps: [step({ conditions: conditions(MAX_FILTERS + 1) })] }))).toEqual([{ path: ['steps', 0, 'conditions'], code: 'too-many' }]);
    expect(problems(definition({ steps: [step({ conditions: [...conditions(MAX_FILTERS), ...conditions(MAX_FILTERS, 'relationship')] })] }))).toEqual([]);
    const values = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: 'number', value: index }));
    expect(problems(definition({ steps: [step({ conditions: [{ op: 'in', on: 'neighbor', property: 'p', values: values(MAX_FILTER_VALUES) }] })] }))).toEqual([]);
    expect(problems(definition({ steps: [step({ conditions: [{ op: 'in', on: 'neighbor', property: 'p', values: values(MAX_FILTER_VALUES + 1) }] })] }))).toEqual([{ path: ['steps', 0, 'conditions', 0, 'values'], code: 'too-many' }]);
    const twelve = [...conditions(MAX_FILTERS), ...conditions(MAX_FILTERS, 'relationship')];
    expect(problems(definition({ steps: [step({ conditions: twelve }), step({ conditions: twelve })] }))).toEqual([]);
    expect(problems(definition({ steps: [step({ conditions: twelve }), step({ conditions: twelve }), step({ conditions: conditions(1) })] }))).toEqual([{ path: ['steps'], code: 'too-many' }]);
  });
});

describe('a pattern with far more than the caps', () => {
  it('is answered with the one problem of the list that is too long, not with a problem for each item', () => {
    const bad = Array.from({ length: 20_000 }, () => ({ op: 'like' }));
    expect(problems(definition({ steps: [step({ conditions: bad })] }))).toEqual([{ path: ['steps', 0, 'conditions'], code: 'too-many' }]);
  });

  it('lists at most MAX_PATTERN_PROBLEMS problems, so an input with many faults cannot make an answer of unbounded size', () => {
    const many = Array.from({ length: 4 }, () => step({ conditions: Array.from({ length: 12 }, () => ({ op: 'like' })) }));
    const found = problems({ anchorType: 'maker', steps: many });
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(MAX_PATTERN_PROBLEMS);
    const wide = { anchorType: 7, steps: Array.from({ length: 4 }, () => ({ relationshipTypes: Array.from({ length: 6 }, () => 5), direction: 1, arrivesAt: 2, conditions: Array.from({ length: 12 }, () => 'x') })) };
    expect(problems(wide).length).toBeLessThanOrEqual(MAX_PATTERN_PROBLEMS);
  });
});

describe('the limits of a pattern', () => {
  it('are named constants, and the ones reused are the constants they reuse', () => {
    expect(PATTERN_LIMITS).toEqual({ steps: 4, relationshipTypesPerStep: 6, conditionsPerElement: MAX_FILTERS, conditionsPerPattern: 24, valuesPerCondition: MAX_FILTER_VALUES, patternsPerSource: 200, nameLength: 100 });
    expect(PATTERN_LIMITS.conditionsPerElement).toBe(6);
    expect(PATTERN_LIMITS.valuesPerCondition).toBe(20);
  });
});

describe('the problems of a definition', () => {
  it('are a code from the closed list and a path of keys and indices, with no message and no value of the input, in the same order every time', () => {
    const sentinel = 'SENTINEL-VALUE';
    const bad = definition({ anchorType: 7, steps: [step({ direction: sentinel, relationshipTypes: [sentinel, sentinel], conditions: [{ op: sentinel, on: 'neighbor', property: sentinel }] }), step({ arrivesAt: undefined })] });
    const first = problems(bad);
    expect(first.length).toBeGreaterThan(2);
    expect(problems(bad)).toEqual(first);
    for (const problem of first) {
      expect(Object.keys(problem).sort()).toEqual(['code', 'path']);
      expect(PATTERN_PROBLEM_CODES).toContain(problem.code);
      expect(problem.path.every((key) => typeof key === 'string' || Number.isInteger(key))).toBe(true);
    }
    expect(JSON.stringify(first)).not.toContain(sentinel);
  });
});

describe('the request and the answer of the route', () => {
  it('take a strict envelope with any object as the definition, and answer ok or invalid with at least one problem', () => {
    expect(patternValidateRequestSchema.safeParse({ sourceId: 's', definition: { anything: 1 }, mask: true }).success).toBe(true);
    expect(patternValidateRequestSchema.safeParse({ sourceId: 's', definition: [] }).success).toBe(false);
    expect(patternValidateRequestSchema.safeParse({ sourceId: 's', definition: {}, other: 1 }).success).toBe(false);
    expect(patternValidateRequestSchema.safeParse({ definition: {} }).success).toBe(false);
    expect(patternValidateResponseSchema.safeParse({ status: 'ok' }).success).toBe(true);
    expect(patternValidateResponseSchema.safeParse({ status: 'invalid', problems: [{ path: ['steps', 0], code: 'too-many' }] }).success).toBe(true);
    expect(patternValidateResponseSchema.safeParse({ status: 'invalid', problems: [] }).success).toBe(false);
    const listed = (count: number) => ({ status: 'invalid', problems: Array.from({ length: count }, (_unused, index) => ({ path: ['steps', index], code: 'too-many' })) });
    expect(patternValidateResponseSchema.safeParse(listed(MAX_PATTERN_PROBLEMS)).success).toBe(true);
    expect(patternValidateResponseSchema.safeParse(listed(MAX_PATTERN_PROBLEMS + 1)).success).toBe(false);
    expect(patternValidateResponseSchema.safeParse({ status: 'invalid', problems: [{ path: [], code: 'because' }] }).success).toBe(false);
    expect(patternValidateResponseSchema.safeParse({ status: 'ok', problems: [] }).success).toBe(false);
  });
});

describe('the request and the answer of the preview route', () => {
  const name = { type: 'a', name: 'A' };
  const preview = {
    start: { ...name, text: 'Start: A' },
    steps: [{ relationshipTypes: ['R'], direction: 'out', arrivesAt: name, text: 'Step 1: follow R forward to A', conditions: [] }],
    bounds: { hopLimit: { value: 4, text: 'x' }, pageLimit: { value: 50, text: 'y' }, countCap: { value: 500, text: 'z' } },
  };

  it('takes the envelope of the validation, and answers a preview of typed parts or the problems of the validation with no preview', () => {
    expect(patternValidateRequestSchema.safeParse({ sourceId: 's', definition: {}, mask: true }).success).toBe(true);
    expect(patternValidateRequestSchema.safeParse({ sourceId: 's', definition: {}, other: 1 }).success).toBe(false);
    expect(patternPreviewResponseSchema.safeParse({ status: 'ok', preview }).success).toBe(true);
    expect(patternPreviewResponseSchema.safeParse({ status: 'ok', preview: { ...preview, extra: 1 } }).success).toBe(false);
    expect(patternPreviewResponseSchema.safeParse({ status: 'ok', preview: { ...preview, steps: [] } }).success).toBe(false);
    expect(patternPreviewResponseSchema.safeParse({ status: 'ok', preview: { ...preview, bounds: { ...preview.bounds, hopLimit: { value: -1, text: 'x' } } } }).success).toBe(false);
    expect(patternPreviewResponseSchema.safeParse({ status: 'invalid', problems: [{ path: ['steps'], code: 'too-many-hops' }] }).success).toBe(true);
    expect(patternPreviewResponseSchema.safeParse({ status: 'invalid', problems: [{ path: ['steps'], code: 'too-many-hops' }], preview }).success).toBe(false);
  });

  it('knows the problem code of more steps than the source allows', () => {
    expect(PATTERN_PROBLEM_CODES).toContain('too-many-hops');
    expect(patternValidateResponseSchema.safeParse({ status: 'invalid', problems: [{ path: ['steps'], code: 'too-many-hops' }] }).success).toBe(true);
  });

  it('takes a step ordered after the previous one from the second step on, and refuses it on the first and any other value', () => {
    expect(patternDefinitionSchema.safeParse(definition({ steps: [step(), step({ after: 'previous' })] })).success).toBe(true);
    expect(problems(definition({ steps: [step({ after: 'previous' })] }))).toEqual([{ path: ['steps', 0, 'after'], code: 'bad-value' }]);
    expect(problems(definition({ steps: [step(), step({ after: 'next' })] }))).toEqual([{ path: ['steps', 1, 'after'], code: 'bad-value' }]);
    expect(problems(definition({ steps: [step(), step({ after: true })] })).map((problem) => problem.path.join('.'))).toEqual(['steps.1.after']);
  });

  it('takes a delay in minutes, hours or days on a step ordered after the previous one, and parses it back to the same value', () => {
    for (const within of [{ hours: 24 }, { minutes: 90 }, { days: 3 }]) {
      const written = definition({ steps: [step(), step({ after: 'previous', within })] });
      expect(patternDefinitionSchema.parse(written)).toEqual(written);
    }
  });

  it('refuses a delay on a step with no order after the previous one, and on the first step, at the delay', () => {
    expect(problems(definition({ steps: [step(), step({ within: { hours: 24 } })] }))).toEqual([{ path: ['steps', 1, 'within'], code: 'bad-value' }]);
    expect(problems(definition({ steps: [step({ within: { hours: 24 } })] }))).toEqual([
      { path: ['steps', 0, 'within'], code: 'bad-value' },
    ]);
    expect(problems(definition({ steps: [step({ after: 'previous', within: { hours: 24 } })] })).map((problem) => problem.path.join('.'))).toEqual(['steps.0.after', 'steps.0.within']);
  });

  it.each([
    ['two keys', { hours: 1, days: 1 }],
    ['a unit that is not minutes, hours or days', { weeks: 1 }],
    ['no key', {}],
    ['a name every object has', { toString: 1 }],
    ['the constructor', { constructor: 1 }],
    ['a prototype key', JSON.parse('{"__proto__": 1}')],
    ['a fraction', { hours: 1.5 }],
    ['zero', { minutes: 0 }],
    ['a negative number', { hours: -2 }],
    ['a text', { hours: '24' }],
    ['a nested value', { hours: { value: 24 } }],
    ['more than the ceiling in hours', { hours: 8761 }],
    ['more than the ceiling in days', { days: 366 }],
    ['more than the ceiling in minutes', { minutes: 525601 }],
    ['a number beyond any ceiling', { minutes: 1e300 }],
  ])('refuses a delay with %s', (_name, within) => {
    expect(patternProblemsOf(definition({ steps: [step(), step({ after: 'previous', within })] })).map((problem) => problem.code)).toEqual(['bad-value']);
  });

  it('refuses a delay that is not an object', () => {
    for (const within of ['24', 24, null, [1]]) expect(problems(definition({ steps: [step(), step({ after: 'previous', within })] })).map((problem) => problem.path.join('.'))).toEqual(['steps.1.within']);
  });

  it('takes the ceiling itself in each unit: 8,760 hours, 365 days and 525,600 minutes', () => {
    for (const within of [{ hours: PATTERN_WITHIN_MAX_HOURS }, { days: 365 }, { minutes: 525600 }]) expect(problems(definition({ steps: [step(), step({ after: 'previous', within })] }))).toEqual([]);
  });

  it('counts the length of a delay in whole minutes', () => {
    expect([withinMinutesOf({ minutes: 90 }), withinMinutesOf({ hours: 24 }), withinMinutesOf({ days: 3 })]).toEqual([90, 1440, 4320]);
  });

  it('knows the problem code of a time order on a relationship with no mapped time', () => {
    expect(PATTERN_PROBLEM_CODES).toContain('time-not-mapped');
  });

  it('parses every definition written before the fan, the time order and the cycle unchanged: a step with none of the new fields keeps the parsed value it had', () => {
    const old = definition({ steps: [step({ conditions: [eq()], window: { days: 30 } }), step({ direction: 'in' })] });
    expect(patternDefinitionSchema.parse(old)).toEqual(old);
  });

  it('reads the three typed preview parts of a step, strictly, and a validation still answers only ok or its problems', () => {
    const base = { relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: { type: 'maker', name: 'Maker' }, text: 'Step 1', conditions: [] };
    const preview = (extra: Record<string, unknown>) => ({ status: 'ok', preview: { start: { type: 'maker', name: 'Maker', text: 'Start: Maker' }, steps: [{ ...base, ...extra }], bounds: { hopLimit: { value: 4, text: 'a' }, pageLimit: { value: 50, text: 'b' }, countCap: { value: 500, text: 'c' } } } });
    const parts = { fan: { atLeast: 3, direction: 'out', text: 'w' }, timeOrder: { properties: ['seenAt'], previousProperties: ['seenAt'], text: 'w' }, closesAtAnchor: { type: 'maker', name: 'Maker', text: 'w' } };
    expect(patternPreviewResponseSchema.safeParse(preview(parts)).success).toBe(true);
    expect(patternPreviewResponseSchema.safeParse(preview({})).success).toBe(true);
    expect(patternPreviewResponseSchema.safeParse(preview({ fan: { ...parts.fan, atLeast: 1 } })).success).toBe(false);
    expect(patternPreviewResponseSchema.safeParse(preview({ timeOrder: { ...parts.timeOrder, extra: 1 } })).success).toBe(false);
    expect(patternValidateResponseSchema.safeParse({ status: 'ok', fan: parts.fan }).success).toBe(false);
    const twelve = Array.from({ length: 2 * PATTERN_LIMITS.relationshipTypesPerStep }, (_unused, index) => `time${index}`);
    expect(patternPreviewResponseSchema.safeParse(preview({ timeOrder: { properties: twelve, previousProperties: twelve, text: 'w' } })).success).toBe(true);
    expect(patternPreviewResponseSchema.safeParse(preview({ timeOrder: { properties: [...twelve, 'one-more'], previousProperties: [], text: 'w' } })).success).toBe(false);
  });
});
