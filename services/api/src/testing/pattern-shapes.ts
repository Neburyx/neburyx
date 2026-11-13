import { FILTER_KINDS, PATTERN_LIMITS, type FilterKind } from '@neburyx/contracts';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { patternParamsSchema, patternRequestOf } from '../gate/templates/pattern-request.js';
import { patternStatementOf } from '../gate/templates/pattern-statement.js';
import type { SourceAllowlist } from '../gate/types.js';
import { linkedMappingOf } from './linked-entities-fixtures.js';

/**
 * The shape of a pattern: what its statement text depends on besides the names. Steps 1 to 4; for each step its direction, the relationship types it crosses (their facts decide how many groups of rows it reads and
 * how many of its types have no stable ID), its ordered list of conditions and whether a window applies; and, for the whole pattern, how many stop-list rules apply to the type the steps pass through. A name, a type and
 * a value are not part of it.
 */
export type Direction = 'out' | 'in' | 'both';
export type Target = 'neighbor' | 'relationship';
export type Operator = 'eq' | 'in' | 'between-from' | 'between-to' | 'between-both';
export interface Form {
  readonly target: Target;
  readonly operator: Operator;
  readonly kind: FilterKind;
}
export interface StepShape {
  readonly direction: Direction;
  /** The index of a class of type sets (`TYPE_CLASSES`): its types decide the groups of rows and the types with no stable ID. */
  readonly typeClass: number;
  readonly conditions: readonly Form[];
  readonly windowed: boolean;
}
export interface Shape {
  readonly steps: readonly StepShape[];
  /** The stop-list rules on the type the steps pass through: 0, 1 or 2. */
  readonly stopRules: 0 | 1 | 2;
}

/** The relationship types of the fixture, all joining the same type to itself, so that every direction crosses them: what is timed and what has a stable ID is what the shape's classes tell apart. */
export const SHAPE_RELATIONSHIPS = [
  { type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId', observed_at: 'seenAt', filterable: ['lane'] },
  { type: 'ALLIES', from: 'maker', to: 'maker', observed_at: 'seenAt', filterable: ['lane'] },
  { type: 'TRUSTS', from: 'maker', to: 'maker', stable_id: 'trustId', filterable: ['lane'] },
  { type: 'KNOWS', from: 'maker', to: 'maker', filterable: ['lane'] },
  { type: 'SERVES', from: 'maker', to: 'maker', stable_id: 'serveId', observed_at: 'spottedAt', filterable: ['lane'] },
  { type: 'PAIRS', from: 'maker', to: 'maker', stable_id: 'pairId', filterable: ['lane'] },
] as const;
/** A second type, with its own relationships and stop-list rules, so that the checks between steps can differ from one step to the next. */
const TOOL_RELATIONSHIPS = [
  { type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId', filterable: ['lane'] },
  { type: 'MADE_BY', from: 'tool', to: 'maker', stable_id: 'madeId', filterable: ['lane'] },
  { type: 'FIXES', from: 'tool', to: 'tool', stable_id: 'fixId', filterable: ['lane'] },
];
const SHAPE_ENTITIES = [
  { type: 'maker', label: 'Maker', stable_id: 'makerId', filterable: ['region', 'rank'] },
  { type: 'tool', label: 'Tool', stable_id: 'toolId', filterable: ['kind'] },
];
const STOP_RULES = [
  { id: 'rule-a', from: 'maker', to: 'maker', via: ['LINKS', 'maker', 'LINKS'], rule_version: 1, stop_list_property: 'isCommon' },
  { id: 'rule-b', from: 'maker', to: 'maker', via: ['ALLIES', 'maker', 'ALLIES'], rule_version: 1, stop_list_property: 'isHub' },
];
const TOOL_RULES = [
  { id: 'rule-t', from: 'maker', to: 'maker', via: ['USES_TOOL', 'tool', 'MADE_BY'], rule_version: 1, stop_list_property: 'isBusy' },
  { id: 'rule-u', from: 'maker', to: 'maker', via: ['USES_TOOL', 'tool', 'USES_TOOL'], rule_version: 1, stop_list_property: 'isBroken' },
];

/** The mapping of the fixture, with the stop-list rules on the first type and on the second. */
export function shapeMappingOf(stopRules: 0 | 1 | 2 = 0, toolRules: 0 | 1 | 2 = 0) {
  return linkedMappingOf({ entities: SHAPE_ENTITIES, relationships: [...SHAPE_RELATIONSHIPS, ...TOOL_RELATIONSHIPS], derived: [...STOP_RULES.slice(0, stopRules), ...TOOL_RULES.slice(0, toolRules)], patterns: [] });
}

export function shapeSource(stopRules: 0 | 1 | 2 = 0, toolRules: 0 | 1 | 2 = 0) {
  const [source] = shapeMappingOf(stopRules, toolRules).sources;
  if (source === undefined) throw new Error('the mapping has no source');
  return source;
}

export const shapeAllowlist = (stopRules: 0 | 1 | 2 = 0, toolRules: 0 | 1 | 2 = 0): SourceAllowlist => allowlistFromMapping(shapeSource(stopRules, toolRules));

interface TypeClass {
  readonly key: string;
  /** The relationship types of the class, as the representative subset names them. */
  readonly types: readonly string[];
  readonly unkeyed: number;
}

/**
 * The classes of type sets: every non-empty subset of the fixture's types, told apart by what changes the text: the groups of rows the step reads in the order the mapping gives them, each timed or not (a window is
 * written only for a timed group) with the number of its types, and the types with no stable ID.
 */
function typeClassesOf(): readonly TypeClass[] {
  const rows = SHAPE_RELATIONSHIPS;
  const seen = new Map<string, TypeClass>();
  for (let mask = 1; mask < 1 << rows.length; mask += 1) {
    const chosen = rows.filter((_row, index) => (mask & (1 << index)) !== 0);
    const groups = new Map<string, number>();
    for (const row of chosen) {
      const property = 'observed_at' in row ? row.observed_at : '';
      groups.set(property, (groups.get(property) ?? 0) + 1);
    }
    const unkeyed = chosen.filter((row) => !('stable_id' in row)).length;
    const key = `${chosen.length}|${[...groups].map(([property, size]) => `${property === '' ? 'U' : 'T'}${size}`).join('+')}|${unkeyed}`;
    if (!seen.has(key)) seen.set(key, { key, types: chosen.map((row) => row.type), unkeyed });
  }
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
}
/** Every subset of the fixture's types, with the key of its class. */
export function subsetsOfClasses(): readonly { readonly key: string; readonly types: readonly string[] }[] {
  const rows = SHAPE_RELATIONSHIPS;
  return Array.from({ length: (1 << rows.length) - 1 }, (_unused, index) => {
    const chosen = rows.filter((_row, position) => ((index + 1) & (1 << position)) !== 0);
    const groups = new Map<string, number>();
    for (const row of chosen) groups.set('observed_at' in row ? row.observed_at : '', (groups.get('observed_at' in row ? row.observed_at : '') ?? 0) + 1);
    const key = `${chosen.length}|${[...groups].map(([property, size]) => `${property === '' ? 'U' : 'T'}${size}`).join('+')}|${chosen.filter((row) => !('stable_id' in row)).length}`;
    return { key, types: chosen.map((row) => row.type) };
  });
}
export const TYPE_CLASSES = typeClassesOf();

export const DIRECTIONS: readonly Direction[] = ['out', 'in', 'both'];
export const TARGETS: readonly Target[] = ['neighbor', 'relationship'];
const OPERATORS: readonly Operator[] = ['eq', 'in', 'between-from', 'between-to', 'between-both'];

/** The forms of a condition for one target: eq and in for each of the eight kinds, and between with `from`, with `to` and with both for the seven kinds that are not boolean (8 + 8 + 21 = 37). */
export function formsOf(target: Target): readonly Form[] {
  return OPERATORS.flatMap((operator) => FILTER_KINDS.filter((kind) => !(operator.startsWith('between') && kind === 'boolean')).map((kind): Form => ({ target, operator, kind })));
}
export const FORMS_PER_TARGET = formsOf('neighbor').length;

const SAMPLE: Readonly<Record<FilterKind, string | number | boolean>> = {
  text: 'a',
  number: 1,
  boolean: true,
  date: '2026-01-01',
  dateTime: '2026-01-01T00:00:00Z',
  localDateTime: '2026-01-01T00:00:00',
  time: '10:00:00Z',
  localTime: '10:00:00',
};
const LATER: Readonly<Record<FilterKind, string | number | boolean>> = { ...SAMPLE, text: 'b', number: 2, boolean: false, date: '2026-02-01', dateTime: '2026-02-01T00:00:00Z', localDateTime: '2026-02-01T00:00:00', time: '11:00:00Z', localTime: '11:00:00' };

const valueOf = (kind: FilterKind, table: Readonly<Record<FilterKind, string | number | boolean>> = SAMPLE) => ({ kind, value: table[kind] });

function conditionOf(form: Form, alternate = false, text?: string): Record<string, unknown> {
  const first = text === undefined ? (alternate ? LATER : SAMPLE) : { ...(alternate ? LATER : SAMPLE), text };
  const second = alternate ? SAMPLE : LATER;
  const property = form.target === 'neighbor' ? 'region' : 'lane';
  const base = { on: form.target, property };
  if (form.operator === 'eq') return { ...base, op: 'eq', value: valueOf(form.kind, first) };
  if (form.operator === 'in') return { ...base, op: 'in', values: [valueOf(form.kind, first), valueOf(form.kind, second)] };
  if (form.operator === 'between-from') return { ...base, op: 'between', from: valueOf(form.kind, first) };
  if (form.operator === 'between-to') return { ...base, op: 'between', to: valueOf(form.kind, second) };
  return { ...base, op: 'between', from: valueOf(form.kind, first), to: valueOf(form.kind, second) };
}

const WINDOW = { windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-02-01T00:00:00Z' };

/** The parameters of a run for a shape, with the names of the fixture mapping. A shape the fixture cannot realize fails here, naming it. */
export function paramsOf(shape: Shape, alternate = false): unknown {
  const steps = shape.steps.map((step) => {
    const kind = TYPE_CLASSES[step.typeClass];
    if (kind === undefined) throw new Error(`the fixture cannot realize the shape ${JSON.stringify(shape)}: no type class ${step.typeClass}`);
    return {
      relationshipTypes: kind.types,
      direction: step.direction,
      arrivesAt: 'maker',
      ...(step.conditions.length === 0 ? {} : { conditions: step.conditions.map((form) => conditionOf(form, alternate)) }),
      ...(step.windowed ? WINDOW : {}),
    };
  });
  return patternParamsSchema.parse({ anchorType: 'maker', stableId: alternate ? 'item-b' : 'item-a', steps });
}

/** The statement the compiler writes for a shape. */
export function statementOfShape(shape: Shape, alternate = false, allowlist: SourceAllowlist = shapeAllowlist(shape.stopRules)): string {
  return patternStatementOf(allowlist, patternRequestOf(allowlist, paramsOf(shape, alternate) as never));
}

/** The same shape as a definition, as a person writes it (a window of days), for the validation. */
export function definitionOf(shape: Shape, text?: string): unknown {
  return {
    anchorType: 'maker',
    steps: shape.steps.map((step) => ({ relationshipTypes: TYPE_CLASSES[step.typeClass]?.types ?? [], direction: step.direction, arrivesAt: 'maker', ...(step.conditions.length === 0 ? {} : { conditions: step.conditions.map((form) => conditionOf(form, false, text)) }), ...(step.windowed ? { window: { days: 7 } } : {}) })),
  };
}


const stepOf = (typeClass: number, over: Partial<StepShape> = {}): StepShape => ({ direction: 'out', typeClass, conditions: [], windowed: false, ...over });
const cycle = <T>(items: readonly T[], from: number, count: number): T[] => Array.from({ length: count }, (_unused, index) => items[(from + index) % items.length] as T);

/** The caps of the shape: the ones the contracts hold, so that a change of one changes the enumeration and the count. */
export const CAPS = { steps: PATTERN_LIMITS.steps, perTarget: PATTERN_LIMITS.conditionsPerElement, perPattern: PATTERN_LIMITS.conditionsPerPattern } as const;

const SELECTED_STEPS = [1, 2, CAPS.steps] as const;

/** The classes the enumerator takes for the types of a step: the smallest, the largest, a split of six into 1 + 5 and into 3 + 3 where they exist, and a class with two types that have no stable ID. */
const sizeOf = (index: number): number => Number(TYPE_CLASSES[index]?.key.split('|')[0]);
export const SELECTED_CLASSES: readonly number[] = [...new Set([0, TYPE_CLASSES.length - 1, ...TYPE_CLASSES.flatMap((cls, index) => (cls.key.startsWith('6|') || cls.unkeyed === 2 || sizeOf(index) === 2 ? [index] : []))])].sort((a, b) => a - b);

/** The shapes the enumerator covers, each once, in a fixed order. */
export function* enumerateShapes(): Generator<Shape> {
  const seen = new Set<string>();
  const emit = (shape: Shape): Shape | undefined => {
    const key = JSON.stringify(shape);
    if (seen.has(key)) return undefined;
    seen.add(key);
    return shape;
  };
  // the structure: every step count, every direction, every selected class of types, with and without a window, and every number of stop-list rules
  for (const count of SELECTED_STEPS) {
    for (const stopRules of [0, 1, 2] as const) {
      for (const [index, typeClass] of SELECTED_CLASSES.entries()) {
        for (const direction of DIRECTIONS) {
          for (const windowed of [false, true]) {
            const steps = cycle(SELECTED_CLASSES, index, count).map((cls, position) => stepOf(cls, { direction: cycle(DIRECTIONS, DIRECTIONS.indexOf(direction), count)[position] ?? direction, windowed: windowed && position % 2 === 0 }));
            steps[0] = stepOf(typeClass, { direction, windowed });
            const shape = emit({ steps, stopRules });
            if (shape !== undefined) yield shape;
          }
        }
      }
    }
  }
  // every single form alone, on the node and on the relationship, with and without a window
  for (const target of TARGETS) {
    for (const form of formsOf(target)) {
      for (const windowed of [false, true]) {
        const shape = emit({ steps: [stepOf(0, { conditions: [form], windowed })], stopRules: 0 });
        if (shape !== undefined) yield shape;
      }
    }
  }
  // the cap: lists as long as the cap allows for a step, cycling through the forms so that each appears, for each step count (the total cut at the pattern's cap)
  const nodeForms = formsOf('neighbor');
  const relationForms = formsOf('relationship');
  for (const count of SELECTED_STEPS) {
    for (let offset = 0; offset < FORMS_PER_TARGET; offset += CAPS.perTarget) {
      let left: number = CAPS.perPattern;
      const steps = Array.from({ length: count }, (_unused, position): StepShape => {
        const node = cycle(nodeForms, offset + position * CAPS.perTarget, Math.min(CAPS.perTarget, left));
        left -= node.length;
        const relation = cycle(relationForms, offset + position * CAPS.perTarget, Math.min(CAPS.perTarget, left));
        left -= relation.length;
        return stepOf(SELECTED_CLASSES[position % SELECTED_CLASSES.length] ?? 0, { direction: DIRECTIONS[position % DIRECTIONS.length] ?? 'out', conditions: [...node, ...relation] });
      });
      const shape = emit({ steps, stopRules: 0 });
      if (shape !== undefined) yield shape;
    }
  }
}

/** The number of shapes the enumerator covers. */
export const enumeratedCount = (): number => [...enumerateShapes()].length;

/**
 * The number of shapes under the caps, by a recurrence over the steps that carries the running number of conditions (so the pattern's cap is in it): a step is a direction, a class of types, a window or not, and an ordered
 * list of conditions with at most `perTarget` on the node and at most `perTarget` on the relationship, in any interleaving, each of 37 forms; the stop-list rules multiply the patterns of two steps or more by 3. A window on a
 * step whose types are all untimed writes the same text as no window, so those shapes are counted twice: the number is of shapes, not of distinct statements.
 */
export function shapeCount(caps: { readonly steps: number; readonly perTarget: number; readonly perPattern: number } = CAPS, sizes: { readonly forms: number; readonly classes: number } = { forms: FORMS_PER_TARGET, classes: TYPE_CLASSES.length }): bigint {
  const forms = BigInt(sizes.forms);
  const choose = (n: number, k: number): bigint => (k < 0 || k > n ? 0n : Array.from({ length: k }, (_unused, index) => BigInt(n - index)).reduce((a, b) => a * b, 1n) / Array.from({ length: k }, (_unused, index) => BigInt(index + 1)).reduce((a, b) => a * b, 1n));
  const lists = new Map<number, bigint>();
  for (let node = 0; node <= caps.perTarget; node += 1) for (let relation = 0; relation <= caps.perTarget; relation += 1) lists.set(node + relation, (lists.get(node + relation) ?? 0n) + choose(node + relation, node) * forms ** BigInt(node + relation));
  const perStep = BigInt(DIRECTIONS.length) * BigInt(sizes.classes) * 2n;
  let states = new Map<number, bigint>([[0, 1n]]);
  let total = 0n;
  for (let step = 1; step <= caps.steps; step += 1) {
    const next = new Map<number, bigint>();
    for (const [used, ways] of states) for (const [size, count] of lists) if (used + size <= caps.perPattern) next.set(used + size, (next.get(used + size) ?? 0n) + ways * perStep * count);
    states = next;
    const shapes = [...states.values()].reduce((a, b) => a + b, 0n);
    total += shapes * (step === 1 ? 1n : 3n);
  }
  return total;
}

/** A small seeded generator, so that a run is the same every time for a seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shapes drawn at random under the caps from a seed, for what the enumerator does not cover. */
export function randomShapes(seed: number, count: number): Shape[] {
  const next = generator(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  return Array.from({ length: count }, (): Shape => {
    let left: number = CAPS.perPattern;
    const steps = Array.from({ length: 1 + Math.floor(next() * CAPS.steps) }, (): StepShape => {
      const conditions: Form[] = [];
      const counts = { neighbor: Math.floor(next() * (CAPS.perTarget + 1)), relationship: Math.floor(next() * (CAPS.perTarget + 1)) };
      for (let index = 0; index < counts.neighbor + counts.relationship && left > 0; index += 1) {
        const target: Target = index < counts.neighbor ? 'neighbor' : 'relationship';
        if (next() < 0.5 && counts.neighbor > 0 && counts.relationship > 0) conditions.splice(Math.floor(next() * (conditions.length + 1)), 0, pick(formsOf(target)));
        else conditions.push(pick(formsOf(target)));
        left -= 1;
      }
      return { direction: pick(DIRECTIONS), typeClass: Math.floor(next() * TYPE_CLASSES.length), conditions, windowed: next() < 0.5 };
    });
    return { steps, stopRules: pick([0, 1, 2] as const) };
  });
}

/** The shapes the grammar is learned from: the enumerated ones, shapes drawn at random, and every aspect of a step at every step, so that no step position is left out. */
export function grammarCorpus(seed = SEED_OF_RECORD, drawn = 600): Shape[] {
  const everywhere: Shape[] = [];
  for (const count of [2, 3, 4]) {
    for (const stopRules of [0, 1, 2] as const) {
      for (const direction of DIRECTIONS) {
        const steps = Array.from({ length: count }, (_unused, position): StepShape => stepOf(SELECTED_CLASSES[(position * 5 + 1) % SELECTED_CLASSES.length] ?? 0, { direction, windowed: true, conditions: [...formsOf('neighbor').slice(position, position + 3), ...formsOf('relationship').slice(position * 2, position * 2 + 3)] }));
        everywhere.push({ steps, stopRules });
      }
    }
  }
  // the ends of a statement: for each step count, each choice of the steps that cross a type with no stable ID (the members read), with a window and none, a condition and none, and two directions
  const keyed = TYPE_CLASSES.findIndex((cls) => cls.key === '1|T1|0');
  const unkeyed = TYPE_CLASSES.findIndex((cls) => cls.key === '1|T1|1');
  for (const count of [1, 2, 3, 4]) {
    for (let mask = 0; mask < 1 << count; mask += 1) {
      for (const windowed of [false, true]) {
        for (const withConditions of [false, true]) {
          for (const direction of ['out', 'both'] as const) {
            const steps = Array.from({ length: count }, (_unused, position): StepShape => stepOf((mask & (1 << position)) === 0 ? keyed : unkeyed, { direction, windowed, conditions: withConditions ? formsOf('neighbor').slice(0, 1) : [] }));
            everywhere.push({ steps, stopRules: 1 });
          }
        }
      }
    }
  }
  // every position of a condition at every step, with every form at it: a step holds the cap of its own, the other steps hold none
  const node = formsOf('neighbor');
  const relation = formsOf('relationship');
  for (const count of [1, 2, 3, 4]) {
    for (let holder = 0; holder < count; holder += 1) {
      for (let offset = 0; offset < FORMS_PER_TARGET; offset += 1) {
        const lists = [[...cycle(node, offset, CAPS.perTarget), ...cycle(relation, offset, CAPS.perTarget)], cycle(node, offset, CAPS.perTarget), cycle(relation, offset, CAPS.perTarget)];
        for (const conditions of lists) {
          for (const windowed of [true, false]) {
            const steps = Array.from({ length: count }, (_unused, position): StepShape => stepOf(0, { windowed, conditions: position === holder ? conditions : [] }));
            everywhere.push({ steps, stopRules: 0 });
          }
        }
      }
    }
  }
  // the longest statement: every step crosses the largest set of types in both directions with a window, the cap's conditions are the longest forms, and every stop-list rule applies
  const widest = TYPE_CLASSES.findIndex((cls) => cls.key.startsWith('6|'));
  const lengthOf = (form: Form): number => statementOfShape({ steps: [stepOf(widest, { direction: 'both', windowed: true, conditions: [form] })], stopRules: 0 }).length;
  const longest = (target: Target): Form[] => [...formsOf(target)].sort((a, b) => lengthOf(b) - lengthOf(a));
  const longNode = longest('neighbor');
  const longRelation = longest('relationship');
  for (const split of [[6, 6, 6, 6], [12, 12, 0, 0], [0, 0, 12, 12], [3, 3, 3, 3]]) {
    const steps = split.map((size): StepShape => stepOf(widest, { direction: 'both', windowed: true, conditions: [...longNode.slice(0, Math.min(size, CAPS.perTarget)), ...longRelation.slice(0, Math.max(0, size - CAPS.perTarget))] }));
    everywhere.push({ steps, stopRules: 2 });
  }
  return [...enumerateShapes(), ...randomShapes(seed, drawn), ...everywhere];
}

export const SEED_OF_RECORD = 5017;

/** The number of draws of the seeded generators of the recorded run. */
export const RECORDED_RUNS = 400;

/** The relationship types of the paths that cross from one type to another: the steps of a path name them by their position. */
export const PATHS: readonly (readonly string[])[] = [
  ['LINKS', 'USES_TOOL', 'MADE_BY'],
  ['USES_TOOL', 'FIXES', 'MADE_BY'],
  ['USES_TOOL', 'MADE_BY', 'LINKS'],
];
const ARRIVES: Readonly<Record<string, string>> = { LINKS: 'maker', USES_TOOL: 'tool', MADE_BY: 'maker', FIXES: 'tool' };

/** The statements of the paths over two types, with every number of stop-list rules on each type, so that the checks between steps differ from one step to the next. */
export function pathEntries(): { readonly name: string; readonly statement: string }[] {
  const out: { name: string; statement: string }[] = [];
  for (const makerRules of [0, 1, 2] as const) {
    for (const toolRules of [0, 1, 2] as const) {
      const allowlist = shapeAllowlist(makerRules, toolRules);
      for (const [pathIndex, path] of PATHS.entries()) {
        for (const withCondition of [false, true]) {
          const steps = path.map((type, index) => ({ relationshipTypes: [type], direction: 'out', arrivesAt: ARRIVES[type], ...(withCondition && index === path.length - 1 ? { conditions: [{ on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'a' } }] } : {}) }));
          out.push({ name: `stop-list/paths/${makerRules}-${toolRules}/path${pathIndex}${withCondition ? '/condition' : ''}`, statement: patternStatementOf(allowlist, patternRequestOf(allowlist, patternParamsSchema.parse({ anchorType: 'maker', stableId: 'item-a', steps }) as never)) });
        }
      }
    }
  }
  return out;
}

export const pathStatements = (): string[] => pathEntries().map((entry) => entry.statement);
