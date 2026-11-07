import type { AggregateEvidenceHit, EvidenceHit, StoredEvidenceHit } from '@neburyx/contracts';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import type { Normalized } from '../gate/normalize/index.js';
import { isTaggedInteger } from '../gate/templates/stable-id.js';
import type { GatePage } from '../gate/types.js';
import type { SourceModel } from '../mapping/model.js';
import { plainNode } from './entity-fixtures.js';

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

const EVIDENCE_STATEMENT = /^CALL \{ (.*) \} WITH r, a, b ORDER BY elementId\(r\) LIMIT \$limit \+ 1 RETURN r, a, b$/;
/** The end of a branch of a search page (the rows after the cursor, sorted by element ID, one more than the page), or of a facet probe (the matches up to the count cap plus one). */
const PAGE_END = (variable: string, returns: string): string =>
  ` AND \\(\\$cursor IS NULL OR elementId\\(${variable}\\) > \\$cursor\\.after\\) WITH ${returns} ORDER BY elementId\\(${variable}\\) LIMIT \\$limit \\+ 1 RETURN ${returns}`;
const EVIDENCE_END = `(?:${PAGE_END('r', 'r, a, b')}| RETURN r, a, b LIMIT \\$countCap \\+ 1)`;
const EVIDENCE_VALUE_BRANCH = new RegExp(`MATCH \\(a:\`([^\`]+)\`\\)-\\[r:\`([^\`]+)\`\\]->\\(b:\`([^\`]+)\`\\) USING RANGE INDEX SEEK r:\`\\2\`\\(\`([^\`]+)\`\\) WHERE r\\.\`\\4\` IN \\[\\$text, \\$textInteger\\]${EVIDENCE_END}`);
const EVIDENCE_TEXT_BRANCH = new RegExp(`MATCH \\(a:\`([^\`]+)\`\\)-\\[r:\`([^\`]+)\`\\]->\\(b:\`([^\`]+)\`\\) USING TEXT INDEX r:\`\\2\`\\(\`([^\`]+)\`\\) WHERE r\\.\`\\4\` = \\$text${EVIDENCE_END}`);

/** The end of a branch of an entity search page (as `PAGE_END`) or of a capped search (cut at one more than the page, unsorted), returning the node and the target's entity type from the gate's list. */
const NODE_PAGE_END = `(?: AND \\(\\$cursor IS NULL OR elementId\\(n\\) > \\$cursor\\.after\\) WITH n ORDER BY elementId\\(n\\)| WITH n) LIMIT \\$limit \\+ 1 RETURN n, \\$branchEntityTypes\\[(\\d+)\\] AS entityType`;
const BRANCH = new RegExp(`MATCH \\(n:\`([^\`]+)\`\\) WHERE n\\.\`([^\`]+)\` (?:IN \\[\\$text, \\$textInteger\\]|= \\$text|STARTS WITH \\$text AND n\\.\`[^\`]+\` <> \\$text)(?:${NODE_PAGE_END}| RETURN n LIMIT \\$countCap \\+ 1)`);

/** The entity type a branch returns: the entry of `$branchEntityTypes` at the position the branch names. */
function branchEntityTypeOf(call: ExecuteCall, position: string): string {
  const types = call.parameters['branchEntityTypes'];
  const entityType: unknown = Array.isArray(types) ? types[Number(position)] : undefined;
  if (typeof entityType !== 'string') throw new Error('a branch names an entity type the statement has no parameter for');
  return entityType;
}

const byElementId = (first: { readonly elementId: string }, second: { readonly elementId: string }): number => (first.elementId < second.elementId ? -1 : first.elementId > second.elementId ? 1 : 0);

/**
 * How many rows a branch reads and from where: a branch of a page reads the rows after the cursor in element ID order, one more than the page; a capped branch reads the first matches it meets,
 * one more than the page; a probe branch reads up to the count cap plus one.
 */
function windowOf<Value extends { readonly elementId: string }>(branch: string, call: ExecuteCall, matched: readonly Value[]): Value[] {
  if (!branch.includes('$cursor') && !branch.includes('$countCap')) return matched.slice(0, call.rowLimit);
  if (!branch.includes('$cursor')) {
    const cap = call.parameters['countCap'];
    if (typeof cap !== 'number') throw new Error('a probe branch is read without the count cap');
    return matched.slice(0, cap + 1);
  }
  const cursor = call.parameters['cursor'];
  const after = typeof cursor === 'object' && cursor !== null && 'after' in cursor && typeof cursor.after === 'string' ? cursor.after : undefined;
  return [...matched].sort(byElementId).filter((value) => after === undefined || value.elementId > after).slice(0, call.rowLimit);
}

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
    const statement = /^CALL \{ (.*) \} WITH n, collect\(DISTINCT entityType\) AS entityTypes( ORDER BY elementId\(n\))? LIMIT \$limit \+ 1 RETURN n, entityTypes$/.exec(call.cypher);
    const inner = statement?.[1];
    if (inner === undefined) throw new Error('the statement is not the search statement');
    const nodes = nodesOf(inner, call, stored, observeBranch);
    // a capped statement keeps the rows in the order its branches met them
    const found = (statement?.[2] === undefined ? nodes : nodes.sort((first, second) => byElementId(first.node, second.node))).slice(0, call.rowLimit);
    return Promise.resolve({ status: 'rows', rows: found.map(({ node, entityTypes }) => ({ n: plainNode([node.label, ...(node.alsoLabels ?? [])], node.properties, node.elementId), entityTypes })) });
  };
}

/** The nodes of the branches of a search statement, each with the entity types of the branches that matched it: each branch matches the label and property and reads no more than its own limit, and the statement keeps one row for a node. */
function nodesOf(inner: string, call: ExecuteCall, stored: readonly StoredNode[], observeBranch: (rows: number) => void): { readonly node: StoredNode; readonly entityTypes: string[] }[] {
  const typesOf = (entityType: string | undefined): string[] => (entityType === undefined ? [] : [entityType]);
  const found = new Map<string, { readonly node: StoredNode; readonly entityTypes: string[] }>();
  for (const branch of inner.split(' UNION ')) {
    const match = BRANCH.exec(branch);
    if (match === null) throw new Error('a branch is not the search branch');
    const [, label, property, position] = match;
    // a probe branch counts nodes and names no entity type
    const entityType = position === undefined ? undefined : branchEntityTypeOf(call, position);
    const text = call.parameters['text'];
    const integer = call.parameters['textInteger'];
    const wanted = branch.includes('IN [$text, $textInteger]') ? [text, isTaggedInteger(integer) ? integer.value : undefined] : [text];
    const matches = (value: unknown): boolean => (branch.includes('STARTS WITH') ? typeof value === 'string' && typeof text === 'string' && value.startsWith(text) && value !== text : wanted.includes(value));
    const read = windowOf(branch, call, stored.filter((node) => (node.label === label || node.alsoLabels?.includes(label ?? '') === true) && typeof node.properties[property ?? ''] === 'string' && matches(node.properties[property ?? ''])));
    observeBranch(read.length);
    for (const node of read) {
      const known = found.get(node.elementId);
      if (known === undefined) found.set(node.elementId, { node, entityTypes: typesOf(entityType) });
      else if (entityType !== undefined && !known.entityTypes.includes(entityType)) known.entityTypes.push(entityType);
    }
  }
  return [...found.values()];
}

/** The one row a facet read answers when a test gives every probe the same count (at most the count cap plus one), for a test whose subject is not the counts. */
export function facetRowOf(call: ExecuteCall, count: number): ExecuteOutcome {
  const columns = /\nRETURN (c\d+(?:, c\d+)*)$/.exec(call.cypher)?.[1];
  const cap = call.parameters['countCap'];
  if (columns === undefined || typeof cap !== 'number') throw new Error('the statement is not the facet statement');
  return { status: 'rows', rows: [Object.fromEntries(columns.split(', ').map((name) => [name, Math.min(count, cap + 1)]))] };
}

const PROBE = /^CALL \{ CALL \{ (.*) \} WITH (n|r) LIMIT \$countCap \+ 1 RETURN count\(\*\) AS c(\d+) \}$/;

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
    row[`c${index}`] = Math.min(found, Number(call.parameters['countCap']) + 1);
  }
  if (last !== `RETURN ${Object.keys(row).join(', ')}`) throw new Error('the facet statement does not end with the one RETURN of its counts');
  return { status: 'rows', rows: [row] };
}

function evidenceProbeOf(inner: string, call: ExecuteCall, relationships: readonly StoredRelationship[], observeBranch: (rows: number) => void): StoredRelationship[] {
  const answer = evidenceAnswer(inner.replaceAll(' RETURN r LIMIT', ' RETURN r, a, b LIMIT'), call, relationships, observeBranch, false);
  if (answer.status !== 'rows') throw new Error('the model answered no rows');
  return relationships.filter((relationship) => answer.rows.some((row) => typeof row['r'] === 'object' && row['r'] !== null && 'elementId' in row['r'] && row['r'].elementId === relationship.elementId));
}

/** The model of the evidence statement: each branch matches a relationship of the type between the labels of its two ends on the property, UNION keeps one row for a relationship, the limit cuts it. */
function evidenceAnswer(inner: string, call: ExecuteCall, relationships: readonly StoredRelationship[], observeBranch: (rows: number) => void, paged = true): ExecuteOutcome {
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
    const read = windowOf(
      branch,
      call,
      relationships.filter((relationship) => relationship.type === type && relationship.from.label === fromLabel && relationship.to.label === toLabel && relationship.properties[property ?? ''] !== undefined && wanted.includes(relationship.properties[property ?? ''])),
    );
    observeBranch(read.length);
    for (const relationship of read) {
      if (seen.has(relationship.elementId)) continue;
      seen.add(relationship.elementId);
      found.push(relationship);
    }
  }
  return {
    status: 'rows',
    rows: (paged ? [...found].sort(byElementId).slice(0, call.rowLimit) : found).map((relationship) => ({
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

/** The hits of an evidence answer on stored relationships, in their order. */
export const storedHits = (hits: readonly EvidenceHit[]): StoredEvidenceHit[] => hits.flatMap((hit) => ('supports' in hit ? [hit] : []));

/** The aggregate hits of an evidence answer (rows with no `stable_id`), in their order. */
export const aggregateHits = (hits: readonly EvidenceHit[]): AggregateEvidenceHit[] => hits.flatMap((hit) => ('aggregate' in hit ? [hit] : []));
