import { MAX_FILTER_TEXT, patternPreviewResponseSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { budgetsFrom } from '../gate/assemble.js';
import { parseMapping } from '../mapping/load.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { previewOrProblems } from './preview.js';
import { validatePattern } from './validate.js';

const ENTITIES = [
  { type: 'maker', label: 'Maker', stable_id: 'makerId', search: ['makerId'], filterable: ['grade', 'since', 'ownerName', 'proud'], pii: [{ property: 'ownerName', class: 'name' }] },
  { type: 'tool', label: 'Tool', stable_id: 'toolId', search: ['toolId'] },
  { type: 'shop', label: 'Shop', stable_id: 'shopId', search: ['shopId'] },
];
const RELATIONSHIPS = [
  { type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId', observed_at: 'seenAt', filterable: ['weight', 'note'] },
  { type: 'KNOWS', from: 'maker', to: 'maker' },
  { type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId' },
  { type: 'STOCKED_AT', from: 'tool', to: 'shop' },
];

function sourceOf(overrides: Record<string, unknown> = {}, entities: readonly unknown[] = ENTITIES) {
  const found = parseMapping(fileOf(baseSource({ id: 'demo', entities, relationships: RELATIONSHIPS, ...overrides })), 'neburyx.yaml').sources[0];
  if (found === undefined) throw new Error('no source');
  return found;
}

const step = (extra: Record<string, unknown> = {}) => ({ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', ...extra });
const definition = (steps: readonly unknown[] = [step()]) => ({ anchorType: 'maker', steps });
const previewOf = (input: unknown, source = sourceOf()) => {
  const answer = previewOrProblems(input, source);
  if (answer.status !== 'ok') throw new Error('not ok');
  return answer.preview;
};

describe('the preview of an acceptable pattern', () => {
  it('names the start and each step by the display names of the types, the relationship types as the mapping names them and the direction in words', () => {
    const preview = previewOf(definition([step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool' }), step({ relationshipTypes: ['STOCKED_AT'], arrivesAt: 'shop', direction: 'out' })]));
    expect(preview.start).toEqual({ type: 'maker', name: 'Maker', text: 'Start: Maker' });
    expect(preview.steps.map((part) => part.text)).toEqual(['Step 1: follow USES_TOOL forward to Tool', 'Step 2: follow STOCKED_AT forward to Shop']);
    expect(previewOf(definition([step({ relationshipTypes: ['LINKS', 'KNOWS'], direction: 'both' })])).steps[0]?.text).toBe('Step 1: follow LINKS or KNOWS in either direction to Maker');
    expect(previewOf(definition([step({ direction: 'in' })])).steps[0]?.text).toBe('Step 1: follow LINKS backward to Maker');
    expect(patternPreviewResponseSchema.parse({ status: 'ok', preview })).toBeTruthy();
  });

  it('follows a display name the mapping gives, and writes no type name of its own', () => {
    const named = sourceOf({}, [{ ...ENTITIES[0], display: { name: 'Craftsperson' } }, ENTITIES[1], ENTITIES[2]]);
    const preview = previewOf(definition(), named);
    expect(preview.start.name).toBe('Craftsperson');
    expect(preview.steps[0]?.arrivesAt.name).toBe('Craftsperson');
    expect(preview.steps[0]?.text).toContain('to Craftsperson');
  });

  it.each([
    [{ max_hops: 2, max_page: 10, heavy_op_threshold: 300 }],
    [{ max_hops: 1, max_page: 1, heavy_op_threshold: 1 }],
    [{ max_hops: 3, max_page: 7, heavy_op_threshold: 4000 }],
  ])('states the limits of the source, as numbers and in words, and follows them when they change (%j)', (budgets) => {
    const preview = previewOf(definition(), sourceOf({ budgets }));
    expect(preview.bounds.hopLimit.value).toBe(budgets.max_hops);
    expect(preview.bounds.pageLimit.value).toBe(budgets.max_page);
    expect(preview.bounds.countCap.value).toBe(budgets.heavy_op_threshold);
    expect(preview.bounds.hopLimit.text).toContain(String(budgets.max_hops));
    expect(preview.bounds.pageLimit.text).toContain(String(budgets.max_page));
    expect(preview.bounds.countCap.text).toContain(String(budgets.heavy_op_threshold));
    expect(preview.bounds.hopLimit.text).toBe(`At most ${budgets.max_hops} ${budgets.max_hops === 1 ? 'step' : 'steps'} in a pattern`);
  });

  it('reads the limits from the same budgets the gate uses', () => {
    const source = sourceOf({ budgets: { max_hops: 3, max_page: 9, heavy_op_threshold: 321 } });
    const bounds = previewOf(definition(), source).bounds;
    const gate = budgetsFrom(source);
    expect([bounds.hopLimit.value, bounds.pageLimit.value, bounds.countCap.value]).toEqual([gate.maxHops, gate.maxPage, gate.countCap]);
  });
});

describe('a pattern with more steps than the source allows', () => {
  it.each([[1], [2], [3]])('is acceptable with exactly max_hops (%i) steps and a problem at steps with one more, in the validation and in the preview alike', (hops) => {
    const source = sourceOf({ budgets: { max_hops: hops } });
    const within = definition(Array.from({ length: hops }, () => step()));
    const over = definition(Array.from({ length: hops + 1 }, () => step()));
    expect(validatePattern(within, source)).toEqual([]);
    expect(previewOrProblems(within, source).status).toBe('ok');
    expect(validatePattern(over, source)).toEqual([{ path: ['steps'], code: 'too-many-hops' }]);
    expect(previewOrProblems(over, source)).toEqual({ status: 'invalid', problems: [{ path: ['steps'], code: 'too-many-hops' }] });
  });

  it('is a problem of the shape alone above four steps, whatever the source allows, and adds the other problems of the mapping to too-many-hops', () => {
    const source = sourceOf({ budgets: { max_hops: 1 } });
    const five = definition(Array.from({ length: 5 }, () => step()));
    expect(validatePattern(five, source)).toEqual([{ path: ['steps'], code: 'too-many' }]);
    const mixed = definition([step({ relationshipTypes: ['NOPE'] }), step()]);
    expect(validatePattern(mixed, source).map((problem) => problem.code)).toEqual(['too-many-hops', 'unknown-relationship-type']);
  });
});

describe('a pattern that does not validate', () => {
  it('answers the problems of the validation and no preview', () => {
    for (const input of [{}, definition([step({ relationshipTypes: ['NOPE'] })]), definition([step({ arrivesAt: 'nothing' })]), { anchorType: 'maker', steps: [] }, definition([step({ extra: 1 })])]) {
      const answer = previewOrProblems(input, sourceOf());
      expect(answer).toEqual({ status: 'invalid', problems: validatePattern(input, sourceOf()) });
      expect(answer).not.toHaveProperty('preview');
    }
  });
});

const text = (value: string) => ({ kind: 'text', value });
const neighbor = (property: string, rest: Record<string, unknown>) => ({ on: 'neighbor', property, ...rest });
const relationship = (property: string, rest: Record<string, unknown>) => ({ on: 'relationship', property, ...rest });
const conditionsOf = (conditions: readonly unknown[], source = sourceOf()) => previewOf(definition([step({ conditions })]), source).steps[0]?.conditions ?? [];

describe('the conditions of a step in words', () => {
  it('say what each applies to, the property as the mapping names it, the operator and the values: eq, in, and between with both ends or one', () => {
    const parts = conditionsOf([
      neighbor('grade', { op: 'eq', value: text('gold') }),
      neighbor('grade', { op: 'in', values: [text('gold'), text('silver')] }),
      relationship('weight', { op: 'between', from: { kind: 'number', value: 2 }, to: { kind: 'number', value: 9 } }),
      relationship('weight', { op: 'between', from: { kind: 'number', value: 2 } }),
      relationship('weight', { op: 'between', to: { kind: 'number', value: 9 } }),
    ]);
    expect(parts.map((part) => part.text)).toEqual(['Maker: grade is "gold"', 'Maker: grade is one of "gold", "silver"', 'LINKS: weight is between 2 and 9', 'LINKS: weight is from 2', 'LINKS: weight is up to 9']);
    expect(parts.map((part) => [part.on, part.op, part.appliesTo])).toEqual([['neighbor', 'eq', 'Maker'], ['neighbor', 'in', 'Maker'], ['relationship', 'between', 'LINKS'], ['relationship', 'between', 'LINKS'], ['relationship', 'between', 'LINKS']]);
  });

  it.each([
    [{ kind: 'text', value: 'gold' }, '"gold"'],
    [{ kind: 'number', value: 12.5 }, '12.5'],
    [{ kind: 'boolean', value: true }, 'true'],
    [{ kind: 'date', value: '2026-01-31' }, '2026-01-31'],
    [{ kind: 'dateTime', value: '2026-01-31T10:00:00Z' }, '2026-01-31T10:00:00Z'],
    [{ kind: 'localDateTime', value: '2026-01-31T10:00:00' }, '2026-01-31T10:00:00'],
    [{ kind: 'time', value: '10:00:00Z' }, '10:00:00Z'],
    [{ kind: 'localTime', value: '10:00:00' }, '10:00:00'],
  ])('gives a value of kind %j as %s and keeps its kind in the typed part', (value, words) => {
    const [part] = conditionsOf([neighbor('since', { op: 'eq', value })]);
    expect(part?.text).toBe(`Maker: since is ${words}`);
    expect(part?.values).toEqual([value]);
  });

  it('holds a value of 256 characters whole and answers a value of 257 with a problem and no preview', () => {
    const whole = 'x'.repeat(MAX_FILTER_TEXT);
    expect(conditionsOf([neighbor('grade', { op: 'eq', value: text(whole) })])[0]?.text).toContain(whole);
    const over = previewOrProblems(definition([step({ conditions: [neighbor('grade', { op: 'eq', value: text(`${whole}x`) })] })]), sourceOf());
    expect(over).toEqual({ status: 'invalid', problems: [{ path: ['steps', 0, 'conditions', 0, 'value', 'value'], code: 'bad-value' }] });
  });

  it('keeps a value with quotes, line breaks and markup as data, whole, in the part and in the words', () => {
    const hostile = 'a "b"\n<script>x</script> \\ `c`';
    const [part] = conditionsOf([neighbor('grade', { op: 'eq', value: text(hostile) })]);
    expect(part?.values).toEqual([text(hostile)]);
    expect(part?.text).toBe(`Maker: grade is "${hostile}"`);
    expect(JSON.parse(JSON.stringify(previewOf(definition([step({ conditions: [neighbor('grade', { op: 'eq', value: text(hostile) })] })])))).steps[0].conditions[0].values[0].value).toBe(hostile);
  });
});

describe('the window of a step in words', () => {
  it('says the days, or the two dates, in UTC, and the relationship types it applies to; a step with no window has none', () => {
    const days = previewOf(definition([step({ window: { days: 30 } }), step({ window: { days: 1 } })])).steps;
    expect(days.map((part) => part.window?.text)).toEqual(['Window on LINKS: the last 30 days (UTC)', 'Window on LINKS: the last 1 day (UTC)']);
    expect(days[0]?.window).toMatchObject({ appliesTo: ['LINKS'], notAppliedTo: [], days: 30 });
    expect(previewOf(definition()).steps[0]).not.toHaveProperty('window');
  });

  it('names apart the relationship types that carry no date in the mapping, which the window does not filter, and says so when it applies to none', () => {
    const mixed = previewOf(definition([step({ relationshipTypes: ['LINKS', 'KNOWS'], window: { from: '2026-01-01', to: '2026-01-31' } })])).steps[0]?.window;
    expect(mixed).toEqual({ appliesTo: ['LINKS'], notAppliedTo: ['KNOWS'], from: '2026-01-01', to: '2026-01-31', text: 'Window on LINKS: from 2026-01-01 to 2026-01-31, both included (UTC). The window does not apply to KNOWS: no date is declared for it' });
    const none = previewOf(definition([step({ relationshipTypes: ['KNOWS'], window: { days: 7 } })])).steps[0]?.window;
    expect(none).toEqual({ appliesTo: [], notAppliedTo: ['KNOWS'], days: 7, text: 'The window does not apply to KNOWS: no date is declared for it' });
  });
});

describe('a condition on personal data', () => {
  const pii = neighbor('ownerName', { op: 'eq', value: text('SENTINEL-PERSON') });

  it('is a problem, and the answer is invalid with no preview and no trace of the value, while masking is asked', () => {
    const answer = previewOrProblems(definition([step({ conditions: [pii] })]), sourceOf(), { mask: true });
    expect(answer).toEqual({ status: 'invalid', problems: [{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'personal-data-masked' }] });
    expect(JSON.stringify(answer)).not.toContain('SENTINEL-PERSON');
  });

  it('shows the value when masking is not asked, as Expand does', () => {
    const answer = previewOrProblems(definition([step({ conditions: [pii] })]), sourceOf());
    expect(answer.status).toBe('ok');
    expect(JSON.stringify(answer)).toContain('SENTINEL-PERSON');
    expect(JSON.stringify(previewOrProblems(definition([step({ conditions: [pii] })]), sourceOf(), { mask: false }))).toContain('SENTINEL-PERSON');
  });

  it('leaves a value of a property that is not personal data visible while masking is asked', () => {
    const answer = previewOrProblems(definition([step({ conditions: [neighbor('grade', { op: 'eq', value: text('gold') })] })]), sourceOf(), { mask: true });
    expect(JSON.stringify(answer)).toContain('gold');
  });
});
