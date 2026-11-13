import { FILTER_KINDS, PATTERN_LIMITS, patternProblemsOf } from '@neburyx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { patternParamsSchema, patternRequestOf } from '../gate/templates/pattern-request.js';
import { patternStatementOf } from '../gate/templates/pattern-statement.js';
import { validatePattern } from '../patterns/validate.js';
import {
  CAPS,
  FORMS_PER_TARGET,
  SHAPE_RELATIONSHIPS,
  TARGETS,
  subsetsOfClasses,
  TYPE_CLASSES,
  definitionOf,
  enumerateShapes,
  enumeratedCount,
  formsOf,
  paramsOf,
  randomShapes,
  shapeAllowlist,
  shapeCount,
  shapeSource,
  statementOfShape,
  type Shape,
} from '../testing/pattern-shapes.js';

// compiling every shape is slow when the suites run together
vi.setConfig({ testTimeout: 60_000 });

const SEED = 5017;
const shapes = [...enumerateShapes()];
const masked = (statement: string): string => statement.replaceAll(/`[^`]*`/g, '`N`');

describe('the forms of a condition', () => {
  it('are 37 for each target: eq and in for the eight kinds, and between with from, with to and with both for the seven kinds that are not boolean', () => {
    expect(FORMS_PER_TARGET).toBe(37);
    for (const target of TARGETS) {
      const forms = formsOf(target);
      expect(forms).toHaveLength(8 + 8 + 7 * 3);
      expect(new Set(forms.map((form) => `${form.operator}/${form.kind}`)).size).toBe(37);
      expect(forms.filter((form) => form.operator.startsWith('between') && form.kind === 'boolean')).toEqual([]);
      expect(new Set(forms.filter((form) => form.operator === 'eq').map((form) => form.kind))).toEqual(new Set(FILTER_KINDS));
    }
  });
});

describe('the enumerator', () => {
  it('yields each shape once, in a fixed order, and its count is the number the code gives', () => {
    expect(enumeratedCount()).toBeGreaterThan(1000);
    expect(new Set(shapes.map((shape) => JSON.stringify(shape))).size).toBe(shapes.length);
    expect([...enumerateShapes()]).toEqual(shapes);
  });

  it('covers every direction, every step count of 1, 2 and the cap, a window and none, each stop-list count, and every single form on each target', () => {
    const steps = shapes.flatMap((shape) => shape.steps);
    expect(new Set(steps.map((step) => step.direction))).toEqual(new Set(['out', 'in', 'both']));
    expect(new Set(shapes.map((shape) => shape.steps.length))).toEqual(new Set([1, 2, CAPS.steps]));
    expect(new Set(steps.map((step) => step.windowed))).toEqual(new Set([true, false]));
    expect(new Set(shapes.map((shape) => shape.stopRules))).toEqual(new Set([0, 1, 2]));
    const alone = new Set(shapes.filter((shape) => shape.steps.length === 1 && shape.steps[0]?.conditions.length === 1).map((shape) => JSON.stringify(shape.steps[0]?.conditions[0])));
    expect(alone.size).toBe(2 * FORMS_PER_TARGET);
  });

  it('keeps every list of conditions within the caps: at most 6 for a target, 12 for a step, 24 in all, and a list at the cap exists', () => {
    for (const shape of shapes) {
      for (const step of shape.steps) {
        expect(step.conditions.filter((form) => form.target === 'neighbor').length).toBeLessThanOrEqual(CAPS.perTarget);
        expect(step.conditions.filter((form) => form.target === 'relationship').length).toBeLessThanOrEqual(CAPS.perTarget);
      }
      expect(shape.steps.reduce((sum, step) => sum + step.conditions.length, 0)).toBeLessThanOrEqual(CAPS.perPattern);
    }
    expect(Math.max(...shapes.map((shape) => shape.steps.reduce((sum, step) => sum + step.conditions.length, 0)))).toBe(CAPS.perPattern);
    expect(Math.max(...shapes.flatMap((shape) => shape.steps.map((step) => step.conditions.length)))).toBe(2 * CAPS.perTarget);
  });

  it('puts every one of the 37 forms of each target into a list at the cap', () => {
    const inCapLists = new Set(shapes.filter((shape) => shape.steps.some((step) => step.conditions.length > 3)).flatMap((shape) => shape.steps.flatMap((step) => step.conditions.map((form) => JSON.stringify(form)))));
    for (const target of TARGETS) for (const form of formsOf(target)) expect(inCapLists.has(JSON.stringify(form)), JSON.stringify(form)).toBe(true);
  });

  it('is smaller than the number of shapes under the caps, which the recurrence gives and which follows a cap that changes', () => {
    expect(BigInt(shapes.length)).toBeLessThan(shapeCount());
    expect(shapeCount({ ...CAPS, perPattern: 12 })).toBeLessThan(shapeCount());
    expect(shapeCount({ ...CAPS, steps: 2 })).toBeLessThan(shapeCount());
    expect(shapeCount({ steps: 1, perTarget: 1, perPattern: 24 })).toBe(BigInt(3 * TYPE_CLASSES.length * 2) * (1n + 2n * 37n + 2n * 37n * 37n));
  });

  it('gives, at small caps, the number of shapes a brute force counts, and follows each cap', () => {
    const brute = (caps: { steps: number; perTarget: number; perPattern: number }, forms: number, classes: number): bigint => {
      const lists: number[] = [];
      for (let node = 0; node <= caps.perTarget; node += 1) for (let relation = 0; relation <= caps.perTarget; relation += 1) for (let order = 0; order < 1 << (node + relation); order += 1) if (Array.from({ length: node + relation }, (_unused, index) => (order >> index) & 1).filter((bit) => bit === 0).length === node) lists.push(node + relation);
      let total = 0n;
      const walk = (step: number, used: number, ways: bigint): void => {
        if (step > caps.steps) return;
        for (const size of lists) {
          if (used + size > caps.perPattern) continue;
          const next = ways * BigInt(3 * classes * 2) * BigInt(forms) ** BigInt(size);
          total += next * (step === 1 ? 1n : 3n);
          walk(step + 1, used + size, next);
        }
      };
      walk(1, 0, 1n);
      return total;
    };
    for (const caps of [{ steps: 2, perTarget: 1, perPattern: 2 }, { steps: 3, perTarget: 1, perPattern: 3 }, { steps: 2, perTarget: 2, perPattern: 3 }]) {
      expect(shapeCount(caps, { forms: 2, classes: 2 })).toBe(brute(caps, 2, 2));
    }
    expect(SHAPE_RELATIONSHIPS.length).toBe(PATTERN_LIMITS.relationshipTypesPerStep);
  });

  it('holds the caps of the contracts', () => {
    expect(CAPS).toEqual({ steps: PATTERN_LIMITS.steps, perTarget: PATTERN_LIMITS.conditionsPerElement, perPattern: PATTERN_LIMITS.conditionsPerPattern });
  });
});

describe('the seeded generator', () => {
  it('gives the same shapes for a seed and other shapes for another, all under the caps', () => {
    expect(randomShapes(SEED, 40)).toEqual(randomShapes(SEED, 40));
    expect(randomShapes(SEED + 1, 40)).not.toEqual(randomShapes(SEED, 40));
    for (const shape of randomShapes(SEED, 200)) {
      expect(shape.steps.length).toBeLessThanOrEqual(CAPS.steps);
      expect(shape.steps.reduce((sum, step) => sum + step.conditions.length, 0)).toBeLessThanOrEqual(CAPS.perPattern);
      for (const step of shape.steps) for (const target of TARGETS) expect(step.conditions.filter((form) => form.target === target).length).toBeLessThanOrEqual(CAPS.perTarget);
    }
  });
});

describe('a shape and the fixture mapping', () => {
  const everything: Shape[] = [...shapes, ...randomShapes(SEED, 300)];

  it('has six relationship types that join one type to itself, so that every direction crosses them, and classes of type sets told apart by the groups and the types with no stable ID', () => {
    expect(SHAPE_RELATIONSHIPS).toHaveLength(6);
    expect(TYPE_CLASSES.length).toBeGreaterThan(6);
    expect(TYPE_CLASSES.some((cls) => cls.key.startsWith('6|'))).toBe(true);
    expect(TYPE_CLASSES.some((cls) => cls.unkeyed === 2)).toBe(true);
  });

  it('is built into a definition that passes the validation and compiles without error, for every shape enumerated and every shape drawn', () => {
    for (const shape of everything) {
      expect(patternProblemsOf(definitionOf(shape)), JSON.stringify(shape)).toEqual([]);
      expect(validatePattern(definitionOf(shape), shapeSource(shape.stopRules)), JSON.stringify(shape)).toEqual([]);
      expect(statementOfShape(shape).length).toBeGreaterThan(0);
    }
  });

  it('compiles to the same text twice, and to the same text for other values and another anchor', () => {
    for (const shape of everything.slice(0, 400)) {
      expect(statementOfShape(shape)).toBe(statementOfShape(shape));
      expect(statementOfShape(shape, true)).toBe(statementOfShape(shape));
    }
  });

  it('differs only in the names for two sets of types of one class, and in the blocks of the step for a set whose groups differ', () => {
    const allowlist = shapeAllowlist(0);
    const compile = (types: readonly string[], over: Record<string, unknown> = {}): string => {
      const params = paramsOf({ steps: [{ direction: 'out', typeClass: 0, conditions: [], windowed: false }], stopRules: 0 }) as { steps: Record<string, unknown>[] };
      return patternStatementOf(allowlist, patternRequestOf(allowlist, { ...params, steps: [{ ...params.steps[0], relationshipTypes: types, ...over }] } as never));
    };
    const window = { windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-02-01T00:00:00Z' };
    const first = compile(['LINKS'], window);
    const second = compile(['SERVES'], window);
    expect(second).not.toBe(first);
    expect(masked(second)).toBe(masked(first));
    const untimed = compile(['TRUSTS'], window);
    expect(masked(untimed)).not.toBe(masked(first));
  });

  it('compiles every set of types of one class to texts that differ only in the names, for every direction, with and without a window and a condition', () => {
    const allowlist = shapeAllowlist(0);
    const classes = new Map<string, string[][]>();
    for (const subset of subsetsOfClasses()) classes.set(subset.key, [...(classes.get(subset.key) ?? []), [...subset.types]]);
    expect([...classes.keys()].length).toBe(TYPE_CLASSES.length);
    const window = { windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-02-01T00:00:00Z' };
    const relationship = { on: 'relationship', property: 'lane', op: 'eq', value: { kind: 'text', value: 'a' } };
    for (const [key, sets] of classes) {
      for (const direction of ['out', 'in', 'both']) {
        for (const extra of [{}, window, { conditions: [relationship] }, { ...window, conditions: [relationship] }]) {
          const texts = sets.map((types) => masked(patternStatementOf(allowlist, patternRequestOf(allowlist, patternParamsSchema.parse({ anchorType: 'maker', stableId: 'item-a', steps: [{ relationshipTypes: types, direction, arrivesAt: 'maker', ...extra }] }) as never))));
          expect(new Set(texts).size, `${key} ${direction} ${JSON.stringify(extra)}`).toBe(1);
        }
      }
    }
  });

  it('fails the test, naming the shape, for a shape the fixture cannot realize', () => {
    const impossible: Shape = { steps: [{ direction: 'out', typeClass: TYPE_CLASSES.length + 3, conditions: [], windowed: false }], stopRules: 0 };
    expect(() => paramsOf(impossible)).toThrow(/cannot realize the shape/);
  });
});
