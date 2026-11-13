import fc from 'fast-check';
import { patternProblemsOf } from '@neburyx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { patternParamsSchema, patternRequestOf } from '../gate/templates/pattern-request.js';
import { patternStatementOf } from '../gate/templates/pattern-statement.js';
import { validatePattern } from '../patterns/validate.js';
import { FUZZ_RUNS, fuzzParams, hostileText, wrongType, UNICODE_SAMPLES } from '../testing/fuzz-corpus.js';
import { GRAMMAR, GRAMMAR_ALLOWLIST } from '../testing/pattern-grammar-fixture.js';
import { grammarProblems } from '../testing/pattern-grammar.js';
import { RECORDED_RUNS, SHAPE_RELATIONSHIPS, definitionOf, randomShapes, shapeSource } from '../testing/pattern-shapes.js';
import { linkedMappingOf } from '../testing/linked-entities-fixtures.js';

// compiling every shape is slow when the suites run together
vi.setConfig({ testTimeout: 60_000 });

const allowlist = GRAMMAR_ALLOWLIST;
const source = shapeSource(2, 2);
const grammar = GRAMMAR;
const known = new Set(['maker', 'Maker', 'makerId', 'region', 'rank', 'lane', 'LINKS', 'ALLIES', 'TRUSTS', 'KNOWS', 'SERVES', 'PAIRS', 'seenAt', 'spottedAt', 'out', 'in', 'both', 'eq', 'in', 'between', 'neighbor', 'relationship', 'kind', 'value', 'text', 'days', 'from', 'to', 'op', 'on', 'property', 'values', 'conditions', 'window', 'steps', 'anchorType', 'direction', 'arrivesAt', 'relationshipTypes']);
const hostile = hostileText(known).filter((text) => text.length >= 4 && !known.has(text));

const step = (over: Record<string, unknown> = {}) => ({ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', ...over });
const definition = (steps: readonly unknown[] = [step()], over: Record<string, unknown> = {}) => ({ anchorType: 'maker', steps, ...over });
const inCondition = (values: readonly unknown[]) => ({ op: 'in', on: 'neighbor', property: 'region', values });
const condition = (over: Record<string, unknown> = {}) => ({ op: 'eq', on: 'neighbor', property: 'region', value: { kind: 'text', value: 'north' }, ...over });

/** The parameters a run takes for a definition that validates: the window of days resolved to two instants, as a run does. */
function paramsOf(input: { anchorType: string; steps: Record<string, unknown>[] }): unknown {
  return patternParamsSchema.parse({
    anchorType: input.anchorType,
    stableId: 'A-1',
    steps: input.steps.map(({ window, ...rest }) => ({ ...rest, ...(window === undefined ? {} : { windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-02-01T00:00:00Z' }) })),
  });
}

/** The outcome for one definition: refused with a code, or compiled to a statement the grammar accepts. */
function outcomeOf(input: unknown, hostileTexts: readonly string[] = []): 'refused' | 'compiled' {
  const problems = validatePattern(input, source);
  if (problems.length > 0) {
    for (const problem of problems) expect(problem.path.every((key) => typeof key === 'string' || Number.isInteger(key))).toBe(true);
    return 'refused';
  }
  const statement = patternStatementOf(allowlist, patternRequestOf(allowlist, paramsOf(input as never) as never));
  expect(grammarProblems(statement, grammar, allowlist)).toEqual([]);
  for (const text of hostileTexts) if (text.length >= 4) expect(statement).not.toContain(text);
  return 'compiled';
}

describe('a hostile definition', () => {
  it('is refused with a code, or compiles to a statement the grammar accepts, and no text of four characters or more of it is in the statement, wherever it is put', () => {
    const placed = fc.tuple(hostile, fc.constantFrom('anchorType', 'relationshipTypes', 'arrivesAt', 'direction', 'property', 'value', 'values', 'window', 'op', 'key', 'kind'));
    fc.assert(
      fc.property(placed, ([text, where]) => {
        const on = { op: where === 'op' ? text : 'eq', on: 'neighbor', property: where === 'property' ? text : 'region', value: { kind: where === 'kind' ? text : 'text', value: where === 'value' ? text : 'a' } };
        const first = where === 'values' ? { op: 'in', on: 'neighbor', property: 'region', values: [{ kind: 'text', value: text }, { kind: 'text', value: 'b' }] } : on;
        const shape = step({
          relationshipTypes: [where === 'relationshipTypes' ? text : 'LINKS'],
          direction: where === 'direction' ? text : 'out',
          arrivesAt: where === 'arrivesAt' ? text : 'maker',
          conditions: [first],
          ...(where === 'window' ? { window: { from: text, to: text } } : {}),
          ...(where === 'key' ? { [text]: 1 } : {}),
        });
        const outcome = outcomeOf(definition([shape], { anchorType: where === 'anchorType' ? text : 'maker' }), [text]);
        if (where !== 'value' && where !== 'values') expect(outcome).toBe('refused');
      }),
      fuzzParams(FUZZ_RUNS),
    );
  });

  it('is, as a value of a mapped condition, refused with a code or compiled with the value a parameter: unicode, control characters and query syntax never reach the statement', () => {
    const syntax = ["' RETURN 1 //", '`) DETACH DELETE n //', 'a\nMATCH (n) DELETE n', '${process.exit()}', '/* x */', 'x'.repeat(256)];
    for (const text of [...UNICODE_SAMPLES, ...syntax]) {
      const outcomes = [
        outcomeOf(definition([step({ conditions: [condition({ value: { kind: 'text', value: text } })] })]), [text]),
        outcomeOf(definition([step({ conditions: [inCondition([{ kind: 'text', value: text }])] })]), [text]),
      ];
      if (syntax.includes(text)) expect(outcomes, JSON.stringify(text)).toEqual(['compiled', 'compiled']);
    }
  });

  it('is refused, with the problem at its own path, for a list over the cap: steps, relationship types, conditions on one target, conditions in all, values of an in', () => {
    const many = (count: number) => Array.from({ length: count }, () => condition());
    const cases: readonly (readonly [unknown, unknown])[] = [
      [definition(Array.from({ length: 5 }, () => step())), [{ path: ['steps'], code: 'too-many' }]],
      [definition([step({ relationshipTypes: ['LINKS', 'ALLIES', 'TRUSTS', 'KNOWS', 'SERVES', 'PAIRS', 'X'] })]), [{ path: ['steps', 0, 'relationshipTypes'], code: 'too-many' }]],
      [definition([step({ conditions: many(7) })]), [{ path: ['steps', 0, 'conditions'], code: 'too-many' }]],
      [definition([step({ conditions: many(6) }), step({ conditions: many(6) }), step({ conditions: many(6) }), step({ conditions: many(6) }), step({ conditions: many(1) })]), [{ path: ['steps'], code: 'too-many' }]],
      [definition([step({ conditions: [inCondition(Array.from({ length: 21 }, (_unused, index) => ({ kind: 'text', value: String(index) })))] })]), [{ path: ['steps', 0, 'conditions', 0, 'values'], code: 'too-many' }]],
    ];
    for (const [input, expected] of cases) {
      const problems = patternProblemsOf(input);
      expect(problems.map((problem) => ({ path: problem.path, code: problem.code }))).toEqual(expect.arrayContaining(expected as never));
      expect(validatePattern(input, source).length).toBeGreaterThan(0);
    }
  });

  it('is refused, with its code, for a value of the wrong kind: text for a number, a list of mixed kinds, between on a boolean, a value of no kind', () => {
    const wrong: readonly unknown[] = [
      condition({ value: { kind: 'number', value: 'x' } }),
      inCondition([{ kind: 'text', value: 'a' }, { kind: 'number', value: 1 }]),
      ({ op: 'between', on: 'neighbor', property: 'region', from: { kind: 'boolean', value: true } }),
      condition({ value: { kind: 'nope', value: 'a' } }),
      condition({ value: { kind: 'boolean', value: 'true' } }),
    ];
    for (const one of wrong) {
      expect(validatePattern(definition([step({ conditions: [one] })]), source), JSON.stringify(one)).not.toEqual([]);
      expect(patternProblemsOf(definition([step({ conditions: [one] })])).every((problem) => Array.isArray(problem.path))).toBe(true);
    }
  });

  it('is refused for a type of another source, and for personal data while masking is asked, and compiles without masking with the value as a parameter', () => {
    expect(validatePattern(definition([step({ arrivesAt: 'invoice' })]), source)).toEqual([{ path: ['steps', 0, 'arrivesAt'], code: 'unknown-entity-type' }]);
    const personal = linkedMappingOf({ entities: [{ type: 'maker', label: 'Maker', stable_id: 'makerId', filterable: ['region'], pii: [{ property: 'region', class: 'text' }] }], relationships: SHAPE_RELATIONSHIPS, derived: [], patterns: [] });
    const [personalSource] = personal.sources;
    if (personalSource === undefined) throw new Error('no source');
    const input = definition([step({ conditions: [condition({ value: { kind: 'text', value: 'SENTINEL-PERSON' } })] })]);
    expect(validatePattern(input, personalSource, { mask: true })).toEqual([{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'personal-data-masked' }]);
    expect(validatePattern(input, personalSource, { mask: false })).toEqual([]);
    const personalAllowlist = allowlistFromMapping(personalSource);
    const statement = patternStatementOf(personalAllowlist, patternRequestOf(personalAllowlist, paramsOf(input as never) as never));
    expect(statement).not.toContain('SENTINEL-PERSON');
  });

  it('is, when it is a random definition with one of its names or values replaced by hostile text, refused with a code or compiled to a statement the grammar accepts, and none of its text is in the statement', () => {
    const draw = fc.tuple(fc.integer({ min: 0, max: 199 }), hostile, fc.constantFrom('anchorType', 'type', 'arrives', 'property', 'value', 'key'));
    const shapes = randomShapes(RECORDED_RUNS, 200);
    let run = 0;
    fc.assert(
      fc.property(draw, ([index, text, where]) => {
        run += 1;
        const base = definitionOf(shapes[index] as never) as { anchorType: string; steps: Record<string, unknown>[] };
        const steps = base.steps.map((one) => ({ ...one, conditions: ((one['conditions'] as Record<string, unknown>[] | undefined) ?? []).map((on) => ({ ...on })) }));
        const first = steps[0] as Record<string, unknown>;
        if (where === 'type') first['relationshipTypes'] = [text];
        else if (where === 'arrives') first['arrivesAt'] = text;
        else if (where === 'key') first[text] = 1;
        else if (where === 'property' || where === 'value') {
          const on = (first['conditions'] as Record<string, unknown>[])[0];
          if (on === undefined) first['conditions'] = [{ ...condition(), ...(where === 'property' ? { property: text } : { value: { kind: 'text', value: text } }) }];
          else if (where === 'property') on['property'] = text;
          else if ('value' in on) on['value'] = { kind: 'text', value: text };
          else on['property'] = text;
        }
        const outcome = outcomeOf({ anchorType: where === 'anchorType' ? text : base.anchorType, steps }, [text]);
        if (where !== 'value') expect(outcome).toBe('refused');
      }),
      fuzzParams(RECORDED_RUNS),
    );
    expect(run).toBe(RECORDED_RUNS);
  });

  it('is refused or compiled, whatever the JSON it is, over the fixed seed, and the number run is the recorded one', () => {
    const json: fc.Arbitrary<unknown> = fc.letrec((tie) => ({ value: fc.oneof({ depthSize: 'small' }, fc.string({ maxLength: 10 }), fc.integer(), fc.boolean(), fc.constant(null), fc.array(tie('value'), { maxLength: 3 }), fc.dictionary(fc.string({ maxLength: 8 }), tie('value'), { maxKeys: 3 })) })).value;
    let run = 0;
    fc.assert(
      fc.property(fc.oneof(json, wrongType), (input) => {
        run += 1;
        const problems = validatePattern(input, source);
        if (problems.length === 0) expect(() => outcomeOf(input)).not.toThrow();
      }),
      fuzzParams(RECORDED_RUNS),
    );
    expect(run).toBe(RECORDED_RUNS);
  });
});

