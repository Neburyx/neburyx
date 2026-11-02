import neo4j from 'neo4j-driver';
import type { CompiledBlock, Definition } from '../definition.js';
import type { MappedEntity, MappingSource } from '../mapping.js';
import type { ExportData } from '../validate.js';
import { quote as q } from '../schema.js';
import { numberOf, query, type RunningNeo4j } from './container.js';

function entityOf(mapping: MappingSource, type: string): MappedEntity {
  const entity = mapping.entities.find((candidate) => candidate.type === type);
  if (entity === undefined) throw new Error('unknown entity type');
  return entity;
}

export function idsOf(data: ExportData, mapping: MappingSource, type: string): string[] {
  const key = entityOf(mapping, type).stableId;
  const rows = data.entities.find((entity) => entity.type === type)?.rows ?? [];
  return rows.map((row) => String(row[key]));
}

export async function populated(server: RunningNeo4j, mapping: MappingSource): Promise<{ labels: Record<string, number>; types: Record<string, number> }> {
  const labels: Record<string, number> = {};
  const types: Record<string, number> = {};
  for (const entity of mapping.entities) labels[entity.type] = numberOf((await query(server, `MATCH (n:${q(entity.label)}) RETURN count(n) AS found`))[0]?.['found']);
  for (const relationship of mapping.relationships) types[relationship.type] = numberOf((await query(server, `MATCH ()-[r:${q(relationship.type)}]->() RETURN count(r) AS found`))[0]?.['found']);
  return { labels, types };
}

export interface Supernode {
  readonly type: string;
  readonly index: number;
  readonly neighbors: number;
}

export function supernodesOf(definition: Definition): Supernode[] {
  return definition.blocks.flatMap((block) => block.supernodes.map((supernode) => ({ type: block.to, index: supernode.to, neighbors: supernode.from.count })));
}

export async function distinctNeighbors(server: RunningNeo4j, mapping: MappingSource, type: string, id: string): Promise<number> {
  const entity = entityOf(mapping, type);
  const rows = await query(server, `MATCH (n:${q(entity.label)} {${q(entity.stableId)}: $id})--(m) RETURN count(DISTINCT m) AS neighbors`, { id });
  return numberOf(rows[0]?.['neighbors']);
}

export function ringBlocks(definition: Definition): CompiledBlock[] {
  return definition.blocks.filter((block) => block.pattern === 'ring');
}

/** For each ring group, the members are exactly the neighbors of its shared node, and the shared node is not on the stop list. */
export async function ringsHold(server: RunningNeo4j, mapping: MappingSource, definition: Definition, data: ExportData, block: CompiledBlock): Promise<void> {
  const from = entityOf(mapping, block.from);
  const to = entityOf(mapping, block.to);
  const fromIds = idsOf(data, mapping, block.from);
  const toIds = idsOf(data, mapping, block.to);
  const wanted = Array.from({ length: block.groups }, (_unused, group) => ({ target: toIds[block.toStart + group], members: fromIds.slice(block.fromStart + group * block.size, block.fromStart + (group + 1) * block.size) }));
  const rows = await query(
    server,
    `MATCH (a:${q(from.label)})-[:${q(block.type)}]->(t:${q(to.label)}) WHERE t.${q(to.stableId)} IN $targets RETURN t.${q(to.stableId)} AS target, collect(a.${q(from.stableId)}) AS members${to.stopList === undefined ? '' : `, t.${q(to.stopList)} AS shared`}`,
    { targets: wanted.map((group) => group.target) },
  );
  const found = new Map(rows.map((row) => [String(row['target']), { members: Array.isArray(row['members']) ? row['members'].map(String).sort() : [], shared: row['shared'] }]));
  for (const group of wanted) {
    const entry = found.get(String(group.target));
    if (entry?.members.join() !== [...group.members].sort().join()) throw new Error(`a ring of ${block.type} does not hold exactly its members`);
    if (entry.shared === true) throw new Error(`a ring of ${block.type} shares a node on the stop list`);
  }
}

export function flaggedIndexes(definition: Definition, type: string): number[] {
  const entity = definition.entities.find((candidate) => candidate.type === type);
  const stop = entity?.properties.find((property) => property.rule.kind === 'byIndex' && property.rule.ranges.some((range) => range.rule.kind === 'constant' && range.rule.value === true));
  if (stop?.rule.kind !== 'byIndex') return [];
  return stop.rule.ranges.filter((range) => range.rule.kind === 'constant' && range.rule.value === true).flatMap((range) => Array.from({ length: range.to - range.from }, (_unused, offset) => range.from + offset));
}

export async function flaggedNodes(server: RunningNeo4j, mapping: MappingSource, type: string): Promise<Map<string, number>> {
  const entity = entityOf(mapping, type);
  if (entity.stopList === undefined) return new Map();
  const rows = await query(server, `MATCH (n:${q(entity.label)}) WHERE n.${q(entity.stopList)} = true OPTIONAL MATCH (n)--(m) RETURN n.${q(entity.stableId)} AS id, count(DISTINCT m) AS neighbors`);
  return new Map(rows.map((row) => [String(row['id']), numberOf(row['neighbors'])]));
}

export async function missingShare(server: RunningNeo4j, mapping: MappingSource, type: string): Promise<{ total: number; missing: number }> {
  const relationship = mapping.relationships.find((candidate) => candidate.type === type);
  if (relationship?.observedAt === undefined) throw new Error('the relationship type has no observed-at property');
  const rows = await query(server, `MATCH ()-[r:${q(type)}]->() RETURN count(r) AS total, count(r.${q(relationship.observedAt)}) AS present`);
  const total = numberOf(rows[0]?.['total']);
  return { total, missing: total - numberOf(rows[0]?.['present']) };
}

export function withinFiveDeviations(total: number, missing: number, probability: number): boolean {
  return Math.abs(missing - total * probability) <= 5 * Math.sqrt(total * probability * (1 - probability));
}

export function missingProbability(definition: Definition, type: string, property: string): number {
  const rules = definition.blocks.filter((block) => block.type === type).flatMap((block) => block.properties).filter((candidate) => candidate.key === property);
  const first = rules[0]?.rule;
  if (first === undefined || first.kind === 'constant') return 0;
  return first.missing;
}

function step(mapping: MappingSource, relationshipType: string, near: string, far: string, nearVariable: string, farVariable: string, nearLabel: string, farLabel: string): string {
  const relationship = mapping.relationships.find((candidate) => candidate.type === relationshipType);
  const forward = relationship?.from === near && relationship.to === far;
  return forward ? `(${nearVariable}:${q(nearLabel)})-[:${q(relationshipType)}]->(${farVariable}:${q(farLabel)})` : `(${nearVariable}:${q(nearLabel)})<-[:${q(relationshipType)}]-(${farVariable}:${q(farLabel)})`;
}

function derivedMatch(mapping: MappingSource, ruleId: string): { match: string; fromKey: string; toKey: string; stop: string | undefined } {
  const rule = mapping.derived.find((candidate) => candidate.id === ruleId);
  if (rule === undefined || rule.via.length !== 3) throw new Error('only three-step rules are tested');
  const [first, middleType, second] = rule.via;
  const from = entityOf(mapping, rule.from);
  const middle = entityOf(mapping, middleType ?? '');
  const to = entityOf(mapping, rule.to);
  const left = step(mapping, first ?? '', rule.from, middle.type, 'a', 'm', from.label, middle.label);
  const right = step(mapping, second ?? '', middle.type, rule.to, 'm', 'b', middle.label, to.label).replace(/^\(m:[^)]*\)/, '(m)');
  return { match: `MATCH ${left}, ${right}`, fromKey: q(from.stableId), toKey: q(to.stableId), stop: rule.stopListProperty === undefined ? undefined : q(rule.stopListProperty) };
}

function stopFilter(stop: string | undefined, applyStopList: boolean): string {
  if (stop === undefined) return '';
  return applyStopList ? ` AND coalesce(m.${stop}, false) = false` : ` AND m.${stop} = true`;
}

/** The distinct pairs a derived rule finds along its via path, from the mapping; with the stop list applied, or only through stop-list nodes. */
export async function derivedPairs(server: RunningNeo4j, mapping: MappingSource, ruleId: string, applyStopList: boolean, limit?: number): Promise<number> {
  const { match, fromKey, toKey, stop } = derivedMatch(mapping, ruleId);
  const rows = await query(
    server,
    `${match} WHERE a.${fromKey} < b.${toKey}${stopFilter(stop, applyStopList)} WITH DISTINCT a.${fromKey} AS x, b.${toKey} AS y${limit === undefined ? '' : ' LIMIT $limit'} RETURN count(*) AS pairs`,
    limit === undefined ? {} : { limit: neo4j.int(limit) },
  );
  return numberOf(rows[0]?.['pairs']);
}

export async function derivedPairExists(server: RunningNeo4j, mapping: MappingSource, ruleId: string, first: string, second: string, applyStopList: boolean): Promise<boolean> {
  const { match, fromKey, toKey, stop } = derivedMatch(mapping, ruleId);
  const [low, high] = first < second ? [first, second] : [second, first];
  const rows = await query(server, `${match} WHERE a.${fromKey} = $low AND b.${toKey} = $high${stopFilter(stop, applyStopList)} RETURN count(*) AS found`, { low, high });
  return numberOf(rows[0]?.['found']) > 0;
}

async function neighborsOfFlagged(server: RunningNeo4j, mapping: MappingSource, middleType: string, id: string, neighborType: string, limit: number): Promise<string[]> {
  const middle = entityOf(mapping, middleType);
  const neighbor = entityOf(mapping, neighborType);
  const rows = await query(server, `MATCH (m:${q(middle.label)} {${q(middle.stableId)}: $id})--(n:${q(neighbor.label)}) RETURN DISTINCT n.${q(neighbor.stableId)} AS id ORDER BY id LIMIT $limit`, { id, limit: neo4j.int(limit) });
  return rows.map((row) => String(row['id']));
}

/**
 * For one derived rule: a pair taken from a ring is found with the stop list applied, and a pair taken from the neighbors of a
 * stop-list node is found without it and gone with it.
 */
export async function derivedRuleHolds(server: RunningNeo4j, mapping: MappingSource, definition: Definition, data: ExportData, ruleId: string): Promise<{ ringPair: [string, string]; stopListPair: [string, string] }> {
  const rule = mapping.derived.find((candidate) => candidate.id === ruleId);
  const middleType = rule?.via[1] ?? '';
  const ring = ringBlocks(definition).find((block) => block.type === rule?.via[0]);
  if (rule === undefined || ring === undefined) throw new Error('the rule has no ring in the definition');
  const members = idsOf(data, mapping, ring.from).slice(ring.fromStart, ring.fromStart + ring.size);
  const ringPair: [string, string] = [members[0] ?? '', members[1] ?? ''];
  if (!(await derivedPairExists(server, mapping, ruleId, ringPair[0], ringPair[1], true))) throw new Error('a ring pair is not found with the stop list applied');

  const flagged = [...(await flaggedNodes(server, mapping, middleType)).keys()];
  for (const id of flagged) {
    const candidates = await neighborsOfFlagged(server, mapping, middleType, id, rule.from, 12);
    for (const first of candidates) {
      for (const second of candidates) {
        if (first >= second) continue;
        if ((await derivedPairExists(server, mapping, ruleId, first, second, false)) && !(await derivedPairExists(server, mapping, ruleId, first, second, true))) {
          return { ringPair, stopListPair: [first, second] };
        }
      }
    }
  }
  throw new Error('no pair that exists only through a stop-list node was found');
}

export function ringPairs(definition: Definition, relationshipType: string): number {
  return ringBlocks(definition)
    .filter((block) => block.type === relationshipType)
    .reduce((total, block) => total + block.groups * ((block.size * (block.size - 1)) / 2), 0);
}

export async function maxNeighbors(server: RunningNeo4j): Promise<number> {
  const rows = await query(server, 'MATCH (n)--(m) WITH n, count(DISTINCT m) AS neighbors RETURN max(neighbors) AS most');
  return numberOf(rows[0]?.['most']);
}
