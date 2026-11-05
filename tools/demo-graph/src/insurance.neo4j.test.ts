import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCases } from './cases.js';
import { readDefinition, type Definition } from './definition.js';
import { writeExport } from './export.js';
import { generate } from './generate.js';
import { loadExport } from './load.js';
import { readMappingSource, type MappingSource } from './mapping.js';
import { packFiles } from './packs.js';
import { readExport, type ExportData } from './validate.js';
import { derivedPairs, derivedRuleHolds, flaggedIndexes, flaggedNodes, idsOf, maxNeighbors, missingProbability, missingShare, populated, ringBlocks, ringPairs, ringsHold, supernodesOf, withinFiveDeviations } from './testing/checks.js';
import { checkCases, presetExists, type Run } from './testing/cases.js';
import { numberOf, query, startNeo4j, type RunningNeo4j } from './testing/container.js';
import { scratch } from './testing/export-helpers.js';

const files = packFiles('insurance-claims');
const LARGEST_NEIGHBORHOOD = 100;
let server: RunningNeo4j;
let mapping: MappingSource;
let definition: Definition;
let data: ExportData;

beforeAll(async () => {
  mapping = readMappingSource(files.mapping);
  definition = readDefinition(files.definition, mapping);
  const directory = join(scratch(), 'export');
  writeExport(directory, generate(mapping, definition, definition.seed));
  data = readExport(directory);
  server = await startNeo4j();
  await loadExport({ directory, source: { ...mapping, database: server.database }, override: server.boltUri, env: { [mapping.usernameEnv]: server.user, [mapping.passwordEnv]: server.password }, reset: false });
});

afterAll(async () => {
  await server?.stop();
});

describe('the insurance demo graph', () => {
  it('has nodes of every mapped entity type and relationships of every mapped relationship type, with the manifest counts', async () => {
    const found = await populated(server, mapping);
    expect(Object.keys(found.labels)).toHaveLength(mapping.entities.length);
    expect(Object.keys(found.types)).toHaveLength(mapping.relationships.length);
    expect(Object.values(found.labels).every((count) => count > 0)).toBe(true);
    expect(Object.values(found.types).every((count) => count > 0)).toBe(true);
    for (const entity of data.entities) expect(found.labels[mapping.entities.find((candidate) => candidate.label === entity.label)?.type ?? '']).toBe(entity.rows.length);
  });

  it('has the stated number of duplicated addresses: the same street and city under different IDs', async () => {
    const rows = await query(server, 'MATCH (a:Address) WITH a.line1 AS street, a.city AS city, count(*) AS copies WHERE copies > 1 RETURN count(*) AS groups, min(copies) AS fewest');
    expect(numberOf(rows[0]?.['groups'])).toBe(40);
    expect(numberOf(rows[0]?.['fewest'])).toBe(3);
  });

  it('has its rings on the phone and on the address, off the stop list', async () => {
    const rings = ringBlocks(definition);
    expect(new Set(rings.map((block) => block.type)).size).toBe(2);
    for (const block of rings) {
      expect(mapping.relationships.some((relationship) => relationship.type === block.type)).toBe(true);
      await ringsHold(server, mapping, definition, data, block);
    }
  });

  it('has a shared phone on the stop list, shared by at least the claimants the definition sends to it', async () => {
    const stopListed = mapping.entities.filter((entity) => entity.stopList !== undefined);
    expect(stopListed).toHaveLength(1);
    const type = stopListed[0]?.type ?? '';
    const indexes = flaggedIndexes(definition, type);
    const flagged = await flaggedNodes(server, mapping, type);
    expect(flagged.size).toBe(indexes.length);
    const ids = idsOf(data, mapping, type);
    for (const index of indexes) {
      const expected = supernodesOf(definition).filter((supernode) => supernode.type === type && supernode.index === index).reduce((total, supernode) => total + supernode.neighbors, 0);
      expect(expected).toBeGreaterThan(0);
      expect(flagged.get(ids[index] ?? '') ?? 0).toBeGreaterThanOrEqual(expected);
    }
  });

  it('has no node with more than 100 neighbors', async () => {
    expect(await maxNeighbors(server)).toBeLessThanOrEqual(LARGEST_NEIGHBORHOOD);
    expect(supernodesOf(definition).every((supernode) => supernode.neighbors <= LARGEST_NEIGHBORHOOD)).toBe(true);
  });

  it('has gaps in its timestamps within five standard deviations of the stated share', async () => {
    for (const relationship of mapping.relationships.filter((candidate) => candidate.observedAt !== undefined)) {
      const { total, missing } = await missingShare(server, mapping, relationship.type);
      expect(missing).toBeGreaterThan(0);
      expect(withinFiveDeviations(total, missing, missingProbability(definition, relationship.type, relationship.observedAt ?? ''))).toBe(true);
    }
  });

  it('gives each derived rule the ring pairs and leaves out a pair that exists only through a stop-list node', async () => {
    expect(mapping.derived.length).toBeGreaterThan(0);
    for (const rule of mapping.derived) {
      expect(await derivedPairs(server, mapping, rule.id, true)).toBeGreaterThanOrEqual(ringPairs(definition, rule.via[0] ?? ''));
      await derivedRuleHolds(server, mapping, definition, data, rule.id);
    }
  });

  it('gives the answer written in its scripted case and holds the starting entity of its preset', async () => {
    const cases = readCases(files.cases, mapping, definition);
    expect(cases.cases).toHaveLength(1);
    const run: Run = (cypher, parameters) => query(server, cypher, parameters);
    expect(await checkCases(cases, mapping, run)).toEqual([]);
    expect(await presetExists(cases, mapping, run)).toBe(true);
  });
});
