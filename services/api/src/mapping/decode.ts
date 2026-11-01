export interface DecodeProblem {
  readonly segments: readonly (string | number)[];
  readonly reason: string;
}

interface State {
  readonly onPath: Set<object>;
  readonly done: Map<object, unknown>;
  readonly problems: DecodeProblem[];
}

function defineOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function convert(value: unknown, segments: readonly (string | number)[], state: State): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (!(value instanceof Map) && !Array.isArray(value)) {
    state.problems.push({ segments, reason: 'holds a value type a mapping does not allow' });
    return undefined;
  }
  if (state.onPath.has(value)) {
    state.problems.push({ segments, reason: 'contains an alias that refers to itself' });
    return undefined;
  }
  if (state.done.has(value)) return state.done.get(value);

  state.onPath.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((member: unknown, index) => convert(member, [...segments, index], state));
  } else {
    // A null prototype keeps keys such as __proto__ and constructor as plain data.
    const copy = Object.create(null);
    for (const [key, member] of value) {
      if (typeof key !== 'string') {
        state.problems.push({ segments, reason: 'has a key that is not text' });
        continue;
      }
      defineOwn(copy, key, convert(member, [...segments, key], state));
    }
    result = copy;
  }
  state.onPath.delete(value);
  state.done.set(value, result);
  return result;
}

/** Turns the parser's maps (decoded with mapAsMap) into null-prototype objects, refusing non-text keys and self-referencing aliases. */
export function decodeYaml(value: unknown): { readonly value: unknown; readonly problems: readonly DecodeProblem[] } {
  const state: State = { onPath: new Set(), done: new Map(), problems: [] };
  const decoded = convert(value, [], state);
  return { value: decoded, problems: state.problems };
}
