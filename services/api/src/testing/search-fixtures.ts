import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import type { Normalized } from '../gate/normalize/index.js';
import { isTaggedInteger } from '../gate/templates/stable-id.js';
import type { GatePage } from '../gate/types.js';
import type { SourceModel } from '../mapping/model.js';
import { entityRows, plainNode } from './entity-fixtures.js';

function isNormalized(item: unknown): item is Normalized {
  return typeof item === 'object' && item !== null && 'nodes' in item && Array.isArray(item.nodes);
}

/** The normalized result a search page holds; fails the test when the page holds anything else. */
export function normalizedOf(page: GatePage): Normalized {
  const [item] = page.items;
  if (!isNormalized(item)) throw new Error('the page does not hold a normalized result');
  return item;
}

export interface StoredNode {
  readonly elementId: string;
  readonly label: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

const BRANCH = /MATCH \(n:`([^`]+)`\) WHERE n\.`([^`]+)` (?:IN \[\$text, \$textInteger\]|= \$text|STARTS WITH \$text AND n\.`[^`]+` <> \$text) RETURN n LIMIT \$limit \+ 1/;

/**
 * A model of the server's answer to the statement of a search: each branch matches the label and property against the text or the integer (or, in a prefix branch, a longer value that
 * starts with the text), UNION keeps one row for a node, and the limit of the statement cuts the combined result. The real server's behaviour is proved on the Neo4j server; this stands in
 * for it where the gate's handling is the subject.
 */
export function searchModelOf(stored: readonly StoredNode[], observeBranch: (rows: number) => void = () => undefined): (call: ExecuteCall) => Promise<ExecuteOutcome> {
  return (call) => {
    const inner = /^CALL \{ (.*) \} WITH n LIMIT \$limit \+ 1 RETURN n$/.exec(call.cypher)?.[1];
    if (inner === undefined) throw new Error('the statement is not the search statement');
    const seen = new Set<string>();
    const nodes: StoredNode[] = [];
    for (const branch of inner.split(' UNION ')) {
      const match = BRANCH.exec(branch);
      if (match === null) throw new Error('a branch is not the search branch');
      const [, label, property] = match;
      const text = call.parameters['text'];
      const integer = call.parameters['textInteger'];
      const wanted = branch.includes('IN [$text, $textInteger]') ? [text, isTaggedInteger(integer) ? integer.value : undefined] : [text];
      const matches = (value: unknown): boolean => (branch.includes('STARTS WITH') ? typeof value === 'string' && typeof text === 'string' && value.startsWith(text) && value !== text : wanted.includes(value));
      // a branch reads no more than its own limit, which is the row limit of the read
      const read = stored.filter((node) => node.label === label && typeof node.properties[property ?? ''] === 'string' && matches(node.properties[property ?? ''])).slice(0, call.rowLimit);
      observeBranch(read.length);
      for (const node of read) {
        if (seen.has(node.elementId)) continue;
        seen.add(node.elementId);
        nodes.push(node);
      }
    }
    return Promise.resolve(entityRows(...nodes.slice(0, call.rowLimit).map((node) => plainNode([node.label], node.properties, node.elementId))));
  };
}

export interface IndexRow {
  readonly type: 'RANGE' | 'TEXT';
  readonly entityType: 'NODE' | 'RELATIONSHIP';
  readonly name: string;
  readonly property: string;
  readonly single: boolean;
  readonly state: string;
  readonly constrained: boolean;
}

export const rangeIndex = (label: string, property: string, state = 'ONLINE', constrained = false): IndexRow => ({ type: 'RANGE', entityType: 'NODE', name: label, property, single: true, state, constrained });
export const textIndex = (label: string, property: string, state = 'ONLINE'): IndexRow => ({ type: 'TEXT', entityType: 'NODE', name: label, property, single: true, state, constrained: false });

/** What the source answers to the schema read: the given indexes, or an answer in the shape the fixture is told to give. */
export function schemaAnswer(indexes: readonly IndexRow[], truncated = false): ExecuteOutcome {
  return { status: 'rows', rows: [{ indexes: [...indexes], truncated }] };
}

/** An executor that answers the schema read from `indexes()` (read at each call, so a test can change it) and every other read from `data`. */
export function withSchema(indexes: () => ExecuteOutcome, data: (call: ExecuteCall) => Promise<ExecuteOutcome>): (call: ExecuteCall) => Promise<ExecuteOutcome> {
  return (call) => (call.templateId === 'schema-indexes' ? Promise.resolve(indexes()) : data(call));
}

/** Every index the mapping's reads need, online: a constraint on each stable ID and a RANGE index on each search property. */
export function onlineIndexesOf(source: SourceModel): IndexRow[] {
  return source.entities.flatMap((entity) => [rangeIndex(entity.label, entity.stableId, 'ONLINE', true), ...entity.search.filter((property) => property !== entity.stableId).map((property) => rangeIndex(entity.label, property))]);
}

/** A responder that answers the schema read with every index of the source online, and every other read with `data`. */
export function withOnlineIndexes(source: SourceModel, data: (call: ExecuteCall) => Promise<ExecuteOutcome>): (call: ExecuteCall) => Promise<ExecuteOutcome> {
  return withSchema(() => schemaAnswer(onlineIndexesOf(source)), data);
}
