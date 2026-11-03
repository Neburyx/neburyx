import neo4j from 'neo4j-driver';
import type { Cases, Expectation } from '../cases.js';
import type { MappedEntity, MappingSource } from '../mapping.js';
import { quote as q } from '../schema.js';

export type Run = (cypher: string, parameters: Record<string, string | boolean | readonly string[]>) => Promise<readonly Record<string, unknown>[]>;

function entityOf(mapping: MappingSource, type: string): MappedEntity {
  const entity = mapping.entities.find((candidate) => candidate.type === type);
  if (entity === undefined) throw new Error('unknown entity type');
  return entity;
}

function whole(value: unknown): number {
  if (neo4j.isInt(value)) return value.toNumber();
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new Error('expected a whole number');
}

async function failureOf(expectation: Expectation, mapping: MappingSource, run: Run): Promise<string | undefined> {
  const node = entityOf(mapping, expectation.node.type);
  const start = `MATCH (n:${q(node.label)} {${q(node.stableId)}: $id})`;
  const parameters = { id: expectation.node.id };
  if (expectation.kind === 'property') {
    const property = `n.${q(expectation.property)}`;
    const rows = await run(`${start} RETURN count(n) AS nodes, count(${property}) AS present, count(CASE WHEN ${property} = $equals THEN 1 END) AS equal`, { ...parameters, equals: expectation.equals });
    const first = rows[0];
    if (first === undefined || whole(first['nodes']) === 0) return 'the node is not in the graph';
    if (whole(first['present']) === 0) return 'the node has no such property';
    return whole(first['equal']) === 0 ? 'the property does not equal the written value' : undefined;
  }
  const neighbor = entityOf(mapping, expectation.neighbor);
  const target = `(m:${q(neighbor.label)})`;
  const edge = `[:${q(expectation.via)}]`;
  const pattern = expectation.direction === 'out' ? `(n)-${edge}->${target}` : `(n)<-${edge}-${target}`;
  const listedIds = expectation.answer.kind === 'ids' ? expectation.answer.ids : undefined;
  const listed = listedIds === undefined ? '' : `, count(DISTINCT CASE WHEN m.${q(neighbor.stableId)} IN $ids THEN m END) AS listed`;
  const rows = await run(`${start} OPTIONAL MATCH ${pattern} RETURN count(DISTINCT n) AS nodes, count(DISTINCT m) AS found${listed}`, listedIds === undefined ? parameters : { ...parameters, ids: listedIds });
  const row = rows[0];
  if (row === undefined || whole(row['nodes']) === 0) return 'the node is not in the graph';
  const found = whole(row['found']);
  if (expectation.answer.kind === 'count') return found === expectation.answer.count ? undefined : `${found} distinct neighbors, not ${expectation.answer.count}`;
  const wanted = expectation.answer.ids.length;
  const matched = whole(row['listed']);
  return found === wanted && matched === wanted ? undefined : `${found} distinct neighbors of which ${matched} are among the ${wanted} listed`;
}

export async function checkCases(cases: Cases, mapping: MappingSource, run: Run): Promise<string[]> {
  const failures: string[] = [];
  for (const demoCase of cases.cases) {
    for (const [index, expectation] of demoCase.expect.entries()) {
      const failure = await failureOf(expectation, mapping, run);
      if (failure !== undefined) failures.push(`case ${demoCase.id}, expectation ${index + 1}: ${failure}`);
    }
  }
  return failures;
}

export async function presetExists(cases: Cases, mapping: MappingSource, run: Run): Promise<boolean> {
  const node = entityOf(mapping, cases.preset.entity.type);
  const rows = await run(`MATCH (n:${q(node.label)} {${q(node.stableId)}: $id}) RETURN count(n) AS found`, { id: cases.preset.entity.id });
  return whole(rows[0]?.['found']) === 1;
}
