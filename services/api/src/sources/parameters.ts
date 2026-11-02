import neo4j from 'neo4j-driver';
import type { Params } from '../gate/types.js';

const ALWAYS_INTEGER = 'limit';

/**
 * Parameters leave the adapter as they came, except the page limit and the parameters the template declares as integers:
 * those that are safe integers become Cypher integers, because a JavaScript number would reach the server as a float.
 */
export function prepareParameters(parameters: Params, integerNames: readonly string[]): Params {
  const names = new Set([...integerNames, ALWAYS_INTEGER]);
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [key, names.has(key) && typeof value === 'number' && Number.isSafeInteger(value) ? neo4j.int(value) : value]),
  );
}
