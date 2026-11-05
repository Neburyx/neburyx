import type { EntityModel, RelationshipModel, SourceModel } from '../mapping/model.js';
import { mappingOf, sourceWith } from './gate-fixtures.js';
import { firstSource } from './mapping.js';
import { runAdmin, type RunningNeo4j } from './neo4j-server.js';

const quote = (name: string): string => `\`${name}\``;

/** The name of the index or constraint the seeding creates, so a test can drop exactly one of them. */
export const nodeIndexName = (label: string, property: string): string => `idx_${label}_${property}`;
export const relationshipIndexName = (type: string, property: string): string => `rel_${type}_${property}`;
export const constraintName = (label: string): string => `uq_${label}`;

function entityStatements(entity: EntityModel): string[] {
  const label = quote(entity.label);
  const statements = [`CREATE CONSTRAINT ${quote(constraintName(entity.label))} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${quote(entity.stableId)} IS UNIQUE`];
  for (const property of new Set([...entity.search, ...entity.reference])) {
    if (property !== entity.stableId) statements.push(`CREATE INDEX ${quote(nodeIndexName(entity.label, property))} IF NOT EXISTS FOR (n:${label}) ON (n.${quote(property)})`);
  }
  return statements;
}

function relationshipStatements(relationship: RelationshipModel): string[] {
  const properties = new Set([...(relationship.stableId === undefined ? [] : [relationship.stableId]), ...relationship.evidence, ...(relationship.observedAt === undefined ? [] : [relationship.observedAt])]);
  return [...properties].map((property) => `CREATE INDEX ${quote(relationshipIndexName(relationship.type, property))} IF NOT EXISTS FOR ()-[r:${quote(relationship.type)}]-() ON (r.${quote(property)})`);
}

/** Which of the pieces of a fitting graph to leave out, for a test that needs one thing missing. */
export interface SeedOptions {
  readonly skipLabels?: readonly string[];
  readonly skipTypes?: readonly string[];
  readonly skipIndexes?: readonly string[];
  readonly skipConstraints?: readonly string[];
}

/**
 * Seeds a graph that fits the source's mapping with the least that every mapping check needs: one node per label carrying its properties, one relationship per type
 * between nodes of its endpoints, the unique constraint of every entity type's stable id, and an index on every search, reference, evidence, sort and relationship
 * stable id property. It waits for the indexes to come online. The data is synthetic.
 */
export async function seedFittingGraph(server: RunningNeo4j, source: SourceModel, options: SeedOptions = {}): Promise<void> {
  const skip = (list: readonly string[] | undefined, name: string): boolean => list?.includes(name) === true;
  for (const entity of source.entities) {
    if (skip(options.skipLabels, entity.label)) continue;
    const properties = [...new Set([entity.stableId, ...entity.search, ...entity.reference])];
    await runAdmin(server, `CREATE (n:${quote(entity.label)}) SET ${properties.map((property, index) => `n.${quote(property)} = $p${index}`).join(', ')}`, Object.fromEntries(properties.map((property, index) => [`p${index}`, `${entity.type}-${property}-1`])));
  }
  for (const relationship of source.relationships) {
    if (skip(options.skipTypes, relationship.type)) continue;
    const from = source.entities.find((entity) => entity.type === relationship.from);
    const to = source.entities.find((entity) => entity.type === relationship.to);
    if (from === undefined || to === undefined || skip(options.skipLabels, from.label) || skip(options.skipLabels, to.label)) continue;
    const properties = [...new Set([...(relationship.stableId === undefined ? [] : [relationship.stableId]), ...relationship.evidence, ...(relationship.observedAt === undefined ? [] : [relationship.observedAt])])];
    const set = properties.length === 0 ? '' : ` SET ${properties.map((property, index) => `r.${quote(property)} = $p${index}`).join(', ')}`;
    await runAdmin(server, `MATCH (a:${quote(from.label)}), (b:${quote(to.label)}) WITH a, b LIMIT 1 CREATE (a)-[r:${quote(relationship.type)}]->(b)${set}`, Object.fromEntries(properties.map((property, index) => [`p${index}`, `${relationship.type}-${property}-1`])));
  }
  await createSchema(server, source, options);
}

/** The constraints and indexes of a fitting graph, created if they are not there (also to put back one that a test dropped), and awaited. */
export async function createSchema(server: RunningNeo4j, source: SourceModel, options: SeedOptions = {}): Promise<void> {
  const skip = (list: readonly string[] | undefined, name: string): boolean => list?.includes(name) === true;
  const statements = [...source.entities.flatMap(entityStatements), ...source.relationships.flatMap(relationshipStatements)];
  for (const statement of statements) {
    const named = /^CREATE (?:CONSTRAINT|INDEX) `([^`]+)`/.exec(statement)?.[1] ?? '';
    const skipped = named.startsWith('uq_') ? skip(options.skipConstraints, named) : skip(options.skipIndexes, named);
    if (!skipped) await runAdmin(server, statement);
  }
  await runAdmin(server, 'CALL db.awaitIndexes(60)');
}

export async function dropIndex(server: RunningNeo4j, name: string): Promise<void> {
  await runAdmin(server, `DROP INDEX ${quote(name)} IF EXISTS`);
}

export async function dropConstraint(server: RunningNeo4j, name: string): Promise<void> {
  await runAdmin(server, `DROP CONSTRAINT ${quote(name)} IF EXISTS`);
}

/** Seeds the graph that fits the mapping of `sourceWith`, which the container suites use for their sources, so that a test run finds the schema it needs. */
export async function seedFixtureGraph(server: RunningNeo4j, options: SeedOptions = {}): Promise<void> {
  await seedFittingGraph(server, firstSource(mappingOf(sourceWith('seed'))), options);
}
