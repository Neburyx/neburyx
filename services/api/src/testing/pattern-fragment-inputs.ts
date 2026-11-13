import { TARGETS, TYPE_CLASSES, formsOf, pathEntries, statementOfShape, type Direction, type Shape, type StepShape } from './pattern-shapes.js';

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
const many = (count: number, stopRules: 0 | 1 | 2 = 0): Shape => ({ steps: Array.from({ length: count }, () => step()), stopRules });

export interface FragmentInput {
  readonly name: string;
  readonly statement: () => string;
}

export function fragmentInputs(): readonly FragmentInput[] {
  const inputs: FragmentInput[] = [];
  const add = (name: string, shape: Shape): void => void inputs.push({ name, statement: () => statementOfShape(shape) });
  add('base', one());
  for (const direction of ['in', 'both'] as const satisfies readonly Direction[]) add(`direction/${direction}`, one({ direction }));
  for (const key of ['2|T1+U1|0', '2|U2|0', '4|T2+U2|1', '4|T1+U3|1', '6|T2+U3+T1|2']) add(`types/${key}`, one({ typeClass: classOf(key) }));
  for (const key of ['2|T1+U1|0', '4|T2+U2|1', '4|T1+U3|1']) add(`groups/both/${key}`, one({ direction: 'both', typeClass: classOf(key) }));
  for (const key of ['1|U1|1', '2|T1+U1|2']) add(`no-stable-id/${key}`, one({ typeClass: classOf(key) }));
  add('window/timed', one({ windowed: true }));
  add('window/mixed', one({ windowed: true, typeClass: classOf('2|T1+U1|0') }));
  for (const target of TARGETS) for (const form of formsOf(target)) add(`condition/${target}/${form.operator}/${form.kind}`, one({ conditions: [form] }));
  for (const count of [2, 3, 4]) add(`steps/${count}`, many(count));
  for (const rules of [1, 2] as const) add(`stop-list/${rules}`, many(2, rules));
  for (const entry of pathEntries()) inputs.push({ name: entry.name, statement: () => entry.statement });
  return inputs;
}

export const fragmentStatements = (): Record<string, string> => Object.fromEntries(fragmentInputs().map((input) => [input.name, input.statement()]));
