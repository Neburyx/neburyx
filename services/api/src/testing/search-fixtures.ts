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
  /** Further labels the node carries, which a branch of one of them matches too. */
  readonly alsoLabels?: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface StoredRelationship {
  readonly elementId: string;
  readonly type: string;
  readonly from: StoredNode;
  readonly to: StoredNode;
  readonly properties: Readonly<Record<string, unknown>>;
}

const EVIDENCE_STATEMENT = /^CALL \{ (.*) \} WITH r, a, b LIMIT \$limit \+ 1 RETURN r, a, b$/;
const EVIDENCE_VALUE_BRANCH = /MATCH \(a:`([^`]+)`\)-\[r:`([^`]+)`\]->\(b:`([^`]+)`\) USING RANGE INDEX SEEK r:`\2`\(`([^`]+)`\) WHERE r\.`\4` IN \[\$text, \$textInteger\] RETURN r, a, b LIMIT \$limit \+ 1/;
const EVIDENCE_TEXT_BRANCH = /MATCH \(a:`([^`]+)`\)-\[r:`([^`]+)`\]->\(b:`([^`]+)`\) USING TEXT INDEX r:`\2`\(`([^`]+)`\) WHERE r\.`\4` = \$text RETURN r, a, b LIMIT \$limit \+ 1/;

const BRANCH = /MATCH \(n:`([^`]+)`\) WHERE n\.`([^`]+)` (?:IN \[\$text, \$textInteger\]|= \$text|STARTS WITH \$text AND n\.`[^`]+` <> \$text) RETURN n LIMIT \$limit \+ 1/;

/**
 * A model of the server's answer to the statement of a search: each branch matches the label and property against the text or the integer (or, in a prefix branch, a longer value that
 * starts with the text), UNION keeps one row for a node, and the limit of the statement cuts the combined result. The real server's behaviour is proved on the Neo4j server; this stands in
 * for it where the gate's handling is the subject.
 */
export function searchModelOf(stored: readonly StoredNode[], observeBranch: (rows: number) => void = () => undefined, relationships: readonly StoredRelationship[] = []): (call: ExecuteCall) => Promise<ExecuteOutcome> {
  return (call) => {
    if (call.templateId === 'search-facets') return Promise.resolve(facetAnswer(call, stored, relationships, observeBranch));
    const evidenceInner = EVIDENCE_STATEMENT.exec(call.cypher)?.[1];
    if (evidenceInner !== undefined) return Promise.resolve(evidenceAnswer(evidenceInner, call, relationships, observeBranch));
    const inner = /^CALL \{ (.*) \} WITH n LIMIT \$limit \+ 1 RETURN n$/.exec(call.cypher)?.[1];
    if (inner === undefined) throw new Error('the statement is not the search statement');
    return Promise.resolve(entityRows(...nodesOf(inner, call, stored, observeBranch).slice(0, call.rowLimit).map((node) => plainNode([node.label, ...(node.alsoLabels ?? [])], node.properties, node.elementId))));
  };
}

/** The nodes of the branches of a search statement: each branch matches the label and property, reads no more than its own limit, and UNION keeps one row for a node. */
function nodesOf(inner: string, call: ExecuteCall, stored: readonly StoredNode[], observeBranch: (rows: number) => void): StoredNode[] {
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
    const read = stored.filter((node) => (node.label === label || node.alsoLabels?.includes(label ?? '') === true) && typeof node.properties[property ?? ''] === 'string' && matches(node.properties[property ?? ''])).slice(0, call.rowLimit);
    observeBranch(read.length);
    for (const node of read) {
      if (seen.has(node.elementId)) continue;
      seen.add(node.elementId);
      nodes.push(node);
    }
  }
  return nodes;
}

/** The one row a facet read answers when a test gives every probe the same count (at most the limit plus one), for a test whose subject is not the counts. */
export function facetRowOf(call: ExecuteCall, count: number): ExecuteOutcome {
  const columns = /\nRETURN (c\d+(?:, c\d+)*)$/.exec(call.cypher)?.[1];
  if (columns === undefined) throw new Error('the statement is not the facet statement');
  return { status: 'rows', rows: [Object.fromEntries(columns.split(', ').map((name) => [name, Math.min(count, call.rowLimit)]))] };
}

const PROBE = /^CALL \{ CALL \{ (.*) \} WITH (n|r) LIMIT \$limit \+ 1 RETURN count\(\*\) AS c(\d+) \}$/;
const EVIDENCE_PROBE_BRANCH_VALUE = /MATCH \(a:`([^`]+)`\)-\[r:`([^`]+)`\]->\(b:`([^`]+)`\) USING RANGE INDEX SEEK r:`\2`\(`([^`]+)`\) WHERE r\.`\4` IN \[\$text, \$textInteger\] RETURN r LIMIT \$limit \+ 1/;

/** The model of the facet statement: one row of counts, one for each probe, each the number of distinct nodes (or relationships) its branches find, cut at the limit plus one. */
function facetAnswer(call: ExecuteCall, stored: readonly StoredNode[], relationships: readonly StoredRelationship[], observeBranch: (rows: number) => void): ExecuteOutcome {
  const lines = call.cypher.split('\n');
  const last = lines.pop();
  const row: Record<string, number> = {};
  for (const line of lines) {
    const match = PROBE.exec(line);
    if (match === null) throw new Error('a line is not a probe of the facet statement');
    const [, inner, variable, index] = match;
    if (inner === undefined || index === undefined) throw new Error('a probe has no branches');
    const found = variable === 'n' ? nodesOf(inner, call, stored, observeBranch).length : evidenceProbeOf(inner, call, relationships, observeBranch).length;
    row[`c${index}`] = Math.min(found, call.rowLimit);
  }
  if (last !== `RETURN ${Object.keys(row).join(', ')}`) throw new Error('the facet statement does not end with the one RETURN of its counts');
  return { status: 'rows', rows: [row] };
}

function evidenceProbeOf(inner: string, call: ExecuteCall, relationships: readonly StoredRelationship[], observeBranch: (rows: number) => void): StoredRelationship[] {
  const answer = evidenceAnswer(inner.replaceAll(' RETURN r LIMIT', ' RETURN r, a, b LIMIT'), call, relationships, observeBranch);
  if (answer.status !== 'rows') throw new Error('the model answered no rows');
  return relationships.filter((relationship) => answer.rows.some((row) => typeof row['r'] === 'object' && row['r'] !== null && 'elementId' in row['r'] && row['r'].elementId === relationship.elementId));
}

/** The model of the evidence statement: each branch matches a relationship of the type between the labels of its two ends on the property, UNION keeps one row for a relationship, the limit cuts it. */
function evidenceAnswer(inner: string, call: ExecuteCall, relationships: readonly StoredRelationship[], observeBranch: (rows: number) => void): ExecuteOutcome {
  const seen = new Set<string>();
  const found: StoredRelationship[] = [];
  for (const branch of inner.split(' UNION ')) {
    const valueBranch = EVIDENCE_VALUE_BRANCH.exec(branch);
    const textBranch = EVIDENCE_TEXT_BRANCH.exec(branch);
    const matched = valueBranch ?? textBranch;
    const [fromLabel, type, toLabel, property] = matched === null ? [] : [matched[1], matched[2], matched[3], matched[4]];
    if (type === undefined) throw new Error('a branch is not the evidence branch');
    const text = call.parameters['text'];
    const integer = call.parameters['textInteger'];
    const wanted = branch.includes('IN [$text, $textInteger]') ? [text, isTaggedInteger(integer) ? integer.value : undefined] : [text];
    const read = relationships
      .filter((relationship) => relationship.type === type && relationship.from.label === fromLabel && relationship.to.label === toLabel && relationship.properties[property ?? ''] !== undefined && wanted.includes(relationship.properties[property ?? '']))
      .slice(0, call.rowLimit);
    observeBranch(read.length);
    for (const relationship of read) {
      if (seen.has(relationship.elementId)) continue;
      seen.add(relationship.elementId);
      found.push(relationship);
    }
  }
  return {
    status: 'rows',
    rows: found.slice(0, call.rowLimit).map((relationship) => ({
      r: { $type: 'relationship', elementId: relationship.elementId, type: relationship.type, startElementId: relationship.from.elementId, endElementId: relationship.to.elementId, properties: relationship.properties },
      a: plainNode([relationship.from.label], relationship.from.properties, relationship.from.elementId),
      b: plainNode([relationship.to.label], relationship.to.properties, relationship.to.elementId),
    })),
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
export const relationshipRangeIndex = (type: string, property: string, state = 'ONLINE'): IndexRow => ({ type: 'RANGE', entityType: 'RELATIONSHIP', name: type, property, single: true, state, constrained: false });
export const relationshipTextIndex = (type: string, property: string, state = 'ONLINE'): IndexRow => ({ type: 'TEXT', entityType: 'RELATIONSHIP', name: type, property, single: true, state, constrained: false });
export const textIndex = (label: string, property: string, state = 'ONLINE'): IndexRow => ({ type: 'TEXT', entityType: 'NODE', name: label, property, single: true, state, constrained: false });

/** What the source answers to the schema read: the given indexes, or an answer in the shape the fixture is told to give. */
export function schemaAnswer(indexes: readonly IndexRow[], truncated = false): ExecuteOutcome {
  return { status: 'rows', rows: [{ indexes: [...indexes], truncated }] };
}

/** An executor that answers the schema read from `indexes()` (read at each call, so a test can change it) and every other read from `data`. */
export function withSchema(indexes: () => ExecuteOutcome, data: (call: ExecuteCall) => Promise<ExecuteOutcome>): (call: ExecuteCall) => Promise<ExecuteOutcome> {
  return (call) => (call.templateId === 'schema-indexes' ? Promise.resolve(indexes()) : data(call));
}

/** Every index the mapping's reads need, online: a constraint on each stable ID and a RANGE index on each search and reference property, and one on each evidence property of a relationship. */
export function onlineIndexesOf(source: SourceModel): IndexRow[] {
  const nodes = source.entities.flatMap((entity) => [rangeIndex(entity.label, entity.stableId, 'ONLINE', true), ...[...new Set([...entity.search, ...entity.reference])].filter((property) => property !== entity.stableId).map((property) => rangeIndex(entity.label, property))]);
  const relationships = source.relationships.flatMap((row) => [...new Set(row.evidence)].map((property) => relationshipRangeIndex(row.type, property)));
  return [...nodes, ...relationships];
}

/** A responder that answers the schema read with every index of the source online, and every other read with `data`. */
export function withOnlineIndexes(source: SourceModel, data: (call: ExecuteCall) => Promise<ExecuteOutcome>): (call: ExecuteCall) => Promise<ExecuteOutcome> {
  return withSchema(() => schemaAnswer(onlineIndexesOf(source)), data);
}
