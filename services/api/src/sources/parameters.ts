import neo4j from 'neo4j-driver';
import { isTaggedInteger } from '../gate/templates/stable-id.js';
import type { Params } from '../gate/types.js';

const ALWAYS_INTEGER = 'limit';

function driverValue(key: string, value: unknown, integerNames: ReadonlySet<string>): unknown {
  if (isTaggedInteger(value)) return neo4j.int(value.value);
  return integerNames.has(key) && typeof value === 'number' && Number.isSafeInteger(value) ? neo4j.int(value) : value;
}

/**
 * Parameters leave the adapter as they came, except the page limit, the parameters the template declares as integers (those that are safe integers become
 * Cypher integers, because a JavaScript number would reach the server as a float) and a tagged 64-bit integer, which becomes a Cypher integer of its exact value.
 */
export function prepareParameters(parameters: Params, integerNames: readonly string[]): Params {
  const names = new Set([...integerNames, ALWAYS_INTEGER]);
  return Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, driverValue(key, value, names)]));
}
