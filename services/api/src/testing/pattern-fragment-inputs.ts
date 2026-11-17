import { TARGETS, countStatementOfShape, TYPE_CLASSES, formsOf, pathEntries, statementOfShape, type Direction, type Shape, type StepShape } from './pattern-shapes.js';

/**
 * The inputs of the fragments of a pattern statement: a base shape (one step, one type, no condition, no window) and, for each value of each input, the same shape with that one input changed. A fragment of the
 * compiler is the text one input value adds to the statement, so the whole statement of each variation is what is stored and checked.
 */
const classOf = (key: string): number => {
  const index = TYPE_CLASSES.findIndex((cls) => cls.key === key);
  if (index < 0) throw new Error(`no type class ${key}`);
  return index;
};

const step = (over: Partial<StepShape> = {}): StepShape => ({ direction: 'out', typeClass: classOf('1|T1|0'), conditions: [], windowed: false, ...over });
const one = (over: Partial<StepShape> = {}, stopRules: 0 | 1 | 2 = 0): Shape => ({ steps: [step(over)], stopRules });
const timed = (count: number, ordered: readonly boolean[], over: Partial<StepShape> = {}): Shape => {
  const { within, ...rest } = over;
  return { steps: Array.from({ length: count }, (_unused, position) => step({ typeClass: classOf('1|T1|0'), ordered: ordered[position] === true, ...rest, ...(ordered[position] === true && within !== undefined ? { within } : {}) })), stopRules: 0 };
};
const many = (count: number, stopRules: 0 | 1 | 2 = 0): Shape => ({ steps: Array.from({ length: count }, () => step()), stopRules });

export interface FragmentInput {
  readonly name: string;
  readonly statement: () => string;
}

/** The count statement a run reads first has the same inputs: it is pinned for each of them beside the run's own statement. */

export function fragmentInputs(): readonly FragmentInput[] {
  const inputs: FragmentInput[] = [];
  const add = (name: string, shape: Shape): void => {
    inputs.push({ name, statement: () => statementOfShape(shape) });
    inputs.push({ name: `count/${name}`, statement: () => countStatementOfShape(shape) });
  };
  add('base', one());
  for (const direction of ['in', 'both'] as const satisfies readonly Direction[]) add(`direction/${direction}`, one({ direction }));
  for (const key of ['2|T1+U1|0', '2|U2|0', '4|T2+U2|1', '4|T1+U3|1', '6|T2+U3+T1|2']) add(`types/${key}`, one({ typeClass: classOf(key) }));
  for (const key of ['2|T1+U1|0', '4|T2+U2|1', '4|T1+U3|1']) add(`groups/both/${key}`, one({ direction: 'both', typeClass: classOf(key) }));
  for (const key of ['1|U1|1', '2|T1+U1|2']) add(`no-stable-id/${key}`, one({ typeClass: classOf(key) }));
  add('window/timed', one({ windowed: true }));
  add('window/mixed', one({ windowed: true, typeClass: classOf('2|T1+U1|0') }));
  for (const target of TARGETS) for (const form of formsOf(target)) add(`condition/${target}/${form.operator}/${form.kind}`, one({ conditions: [form] }));
  for (const count of [2, 3, 4]) add(`steps/${count}`, many(count));
  add('fan/step-1', one({ fan: 3 }));
  add('fan/step-1-in', one({ fan: 3, direction: 'in' }));
  add('fan/step-1-both-groups', one({ fan: 5, direction: 'both', typeClass: classOf('2|T1+U1|0') }));
  add('fan/step-1-conditions-window', one({ fan: 2, windowed: true, conditions: formsOf('neighbor').slice(0, 1) }));
  add('fan/step-2', { steps: [step(), step({ fan: 4 })], stopRules: 0 });
  add('fan/step-2-in', { steps: [step(), step({ fan: 4, direction: 'in' })], stopRules: 0 });
  add('fan/steps-1-and-2', { steps: [step({ fan: 2 }), step({ fan: 3 })], stopRules: 0 });
  add('fan/with-time-order', { steps: [step({ typeClass: classOf('1|T1|0') }), step({ typeClass: classOf('1|T1|0'), fan: 3, ordered: true })], stopRules: 0 });
  const cycle = (count: number, over: Partial<StepShape> = {}, lastOver: Partial<StepShape> = {}): Shape => ({ steps: Array.from({ length: count }, (_unused, position) => step({ typeClass: classOf('1|T1|0'), ...over, ...(position === count - 1 ? { closes: true, ...lastOver } : {}) })), stopRules: 0 });
  add('cycle/2', cycle(2));
  add('cycle/3', cycle(3));
  add('cycle/4', cycle(4));
  add('cycle/2-both', cycle(2, { direction: 'both' }));
  add('cycle/2-in', cycle(2, { direction: 'in' }));
  add('cycle/3-conditions-window', cycle(3, { windowed: true }, { conditions: formsOf('relationship').slice(0, 1) }));
  add('cycle/3-time-order', cycle(3, {}, { ordered: true }));
  add('cycle/3-fan', cycle(3, {}, { fan: 2 }));
  add('cycle/3-stop-list', { ...cycle(3), stopRules: 1 });
  add('time-order/2', timed(2, [false, true]));
  add('time-order/3', timed(3, [false, true, true]));
  add('time-order/3-second-only', timed(3, [false, true, false]));
  add('time-order/windowed', timed(2, [false, true], { windowed: true }));
  add('time-order/in', timed(2, [false, true], { direction: 'in' }));
  add('time-order/within', timed(2, [false, true], { within: 1440 }));
  add('time-order/within-3', timed(3, [false, true, true], { within: 90 }));
  add('time-order/within-in', timed(2, [false, true], { direction: 'in', within: 1440 }));
  add('time-order/within-windowed', timed(2, [false, true], { windowed: true, within: 1440 }));
  add('fan/within', { steps: [step({ typeClass: classOf('1|T1|0') }), step({ typeClass: classOf('1|T1|0'), fan: 3, ordered: true, within: 1440 })], stopRules: 0 });
  add('cycle/3-within', cycle(3, {}, { ordered: true, within: 1440 }));
  add('time-order/different-properties', { steps: [step({ typeClass: classOf('1|T1|0') }), step({ typeClass: classOf('2|T1+T1|0'), ordered: true })], stopRules: 0 });
  for (const rules of [1, 2] as const) add(`stop-list/${rules}`, many(2, rules));
  for (const entry of pathEntries()) {
    inputs.push({ name: entry.name, statement: () => entry.statement });
    inputs.push({ name: `count/${entry.name}`, statement: () => entry.count });
  }
  return inputs;
}

export const fragmentStatements = (): Record<string, string> => Object.fromEntries(fragmentInputs().map((input) => [input.name, input.statement()]));
