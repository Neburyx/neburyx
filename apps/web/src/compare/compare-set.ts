import { isEdgeKey } from '../state/keys.js';
import { COMPARE_MAX_ITEMS, COMPARE_MIN_ITEMS } from './limits.js';

export type SelectionKind = 'entities' | 'relationships' | 'mixed' | 'none';

/** What the keys are: all entities, all relationships, both, or no key. */
export function selectionKind(keys: readonly string[]): SelectionKind {
  if (keys.length === 0) return 'none';
  const edges = keys.filter(isEdgeKey).length;
  return edges === 0 ? 'entities' : edges === keys.length ? 'relationships' : 'mixed';
}

export interface CompareSet {
  readonly kind: 'entities' | 'relationships';
  /** The first `max` of the keys in selection order. */
  readonly compared: readonly string[];
  /** The rest, none dropped without a word. */
  readonly left: readonly string[];
  readonly selected: number;
}

/** The set a selection makes: undefined unless it is two or more of one kind; at most `max` are compared. */
export function pickSet(keys: readonly string[], max: number = COMPARE_MAX_ITEMS, min: number = COMPARE_MIN_ITEMS): CompareSet | undefined {
  const kind = selectionKind(keys);
  if ((kind !== 'entities' && kind !== 'relationships') || keys.length < min) return undefined;
  return { kind, compared: keys.slice(0, max), left: keys.slice(max), selected: keys.length };
}
