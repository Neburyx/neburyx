import type { IndexEntry } from '../gate/templates/schema-indexes.js';
import type { Params } from '../gate/types.js';

const listOf = (params: Params, name: string): string[] => {
  const value = params[name];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

/** The answer of `schema-tokens` for a source that has every mapped label and relationship type. */
export function fittingTokens(params: Params): { labels: string[]; types: string[] } {
  return { labels: listOf(params, 'mappedLabels'), types: listOf(params, 'mappedTypes') };
}

/**
 * The answer of `schema-indexes` for a source that has a constraint-backed index on every mapped property of every mapped label and an index on every mapped
 * property of every mapped type: more than a mapping needs, so every check passes.
 */
export function fittingIndexes(params: Params): { indexes: IndexEntry[]; truncated: boolean } {
  const properties = listOf(params, 'mappedProperties');
  const nodes = listOf(params, 'mappedLabels').flatMap((name) => properties.map((property): IndexEntry => ({ type: 'RANGE', entityType: 'NODE', name, property, single: true, state: 'ONLINE', constrained: true })));
  const relationships = listOf(params, 'mappedTypes').flatMap((name) => properties.map((property): IndexEntry => ({ type: 'RANGE', entityType: 'RELATIONSHIP', name, property, single: true, state: 'ONLINE', constrained: false })));
  return { indexes: [...nodes, ...relationships], truncated: false };
}

/** The answer of the duplicate scan for a source with no duplicate. */
export const NO_DUPLICATES = { duplicated: 0 };
