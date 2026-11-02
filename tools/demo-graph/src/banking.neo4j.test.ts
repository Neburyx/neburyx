import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDefinition, type Definition } from './definition.js';
import { writeExport } from './export.js';
import { generate } from './generate.js';
import { loadExport, type LoadReport } from './load.js';
import { readMappingSource, type MappingSource } from './mapping.js';
import { packFiles } from './packs.js';
import { readExport, type ExportData } from './validate.js';
import { distinctNeighbors, derivedPairs, derivedRuleHolds, flaggedIndexes, flaggedNodes, idsOf, maxNeighbors, missingProbability, missingShare, populated, ringBlocks, ringPairs, ringsHold, supernodesOf, withinFiveDeviations } from './testing/checks.js';
import { startNeo4j, type RunningNeo4j } from './testing/container.js';
import { scratch } from './testing/export-helpers.js';

const files = packFiles('banking-fraud');
let server: RunningNeo4j;
let mapping: MappingSource;
let definition: Definition;
let data: ExportData;
let report: LoadReport;

beforeAll(async () => {
  mapping = readMappingSource(files.mapping);
  definition = readDefinition(files.definition, mapping);
  const directory = join(scratch(), 'export');
  writeExport(directory, generate(mapping, definition, definition.seed));
  data = readExport(directory);
  server = await startNeo4j();
  report = await loadExport({ directory, source: mapping, override: server.boltUri, env: { [mapping.usernameEnv]: server.user, [mapping.passwordEnv]: server.password }, reset: false });
});

afterAll(async () => {
  await server?.stop();
});

describe('the banking demo graph at full size', () => {
  it('is loaded with the counts of the manifest and reports the time of each phase', async ({ annotate }) => {
    const phases = report.phases.map((phase) => `${phase.name} ${(phase.milliseconds / 1000).toFixed(1)} s`).join(', ');
    await annotate(`${server.image}: banking pack loaded in ${(report.totalMilliseconds / 1000).toFixed(1)} s (${phases})`);
    const found = await populated(server, mapping);
    for (const entity of data.entities) expect(found.labels[mapping.entities.find((candidate) => candidate.label === entity.label)?.type ?? '']).toBe(entity.rows.length);
    for (const relationship of data.relationships) expect(found.types[relationship.type]).toBe(relationship.rows.length);
  });

  it('has nodes of every mapped entity type and relationships of every mapped relationship type', async () => {
    const found = await populated(server, mapping);
    expect(Object.values(found.labels).every((count) => count > 0)).toBe(true);
    expect(Object.values(found.types).every((count) => count > 0)).toBe(true);
    expect(Object.keys(found.labels)).toHaveLength(mapping.entities.length);
    expect(Object.keys(found.types)).toHaveLength(mapping.relationships.length);
  });

  it('has three supernodes of exactly 1,000, 10,000 and 100,000 neighbors, each the node the definition names', async () => {
    const big = supernodesOf(definition).filter((supernode) => supernode.neighbors >= 1000);
    expect(big.map((supernode) => supernode.neighbors).sort((left, right) => left - right)).toEqual([1000, 10_000, 100_000]);
    for (const supernode of big) {
      const id = idsOf(data, mapping, supernode.type)[supernode.index] ?? '';
      expect(await distinctNeighbors(server, mapping, supernode.type, id)).toBe(supernode.neighbors);
    }
  });

  it('has its rings: each group shares exactly one node, off the stop list, on the device and on the address', async () => {
    const rings = ringBlocks(definition);
    expect(rings.length).toBeGreaterThanOrEqual(2);
    for (const block of rings) await ringsHold(server, mapping, definition, data, block);
  });

  it('has its NAT devices on the stop list, each shared by at least the accounts the definition sends to it', async () => {
    for (const entity of mapping.entities.filter((candidate) => candidate.stopList !== undefined)) {
      const indexes = flaggedIndexes(definition, entity.type);
      const flagged = await flaggedNodes(server, mapping, entity.type);
      expect(flagged.size).toBe(indexes.length);
      const ids = idsOf(data, mapping, entity.type);
      for (const index of indexes) {
        const expected = supernodesOf(definition).filter((supernode) => supernode.type === entity.type && supernode.index === index).reduce((total, supernode) => total + supernode.neighbors, 0);
        expect(flagged.get(ids[index] ?? '') ?? 0).toBeGreaterThanOrEqual(expected);
      }
    }
  });

  it('has gaps in its timestamps within five standard deviations of the stated share', async () => {
    for (const relationship of mapping.relationships.filter((candidate) => candidate.observedAt !== undefined)) {
      const { total, missing } = await missingShare(server, mapping, relationship.type);
      const probability = missingProbability(definition, relationship.type, relationship.observedAt ?? '');
      expect(missing).toBeGreaterThan(0);
      expect(withinFiveDeviations(total, missing, probability)).toBe(true);
    }
  });

  it('gives each derived rule the ring pairs and leaves out a pair that exists only through a stop-list node', async () => {
    expect(mapping.derived.length).toBeGreaterThan(0);
    for (const rule of mapping.derived) {
      expect(await derivedPairs(server, mapping, rule.id, true)).toBeGreaterThanOrEqual(ringPairs(definition, rule.via[0] ?? ''));
      const { ringPair, stopListPair } = await derivedRuleHolds(server, mapping, definition, data, rule.id);
      expect(ringPair).not.toEqual(stopListPair);
    }
  });

  it('holds the largest neighbourhood that the definition names and no larger', async () => {
    const largest = Math.max(...supernodesOf(definition).map((supernode) => supernode.neighbors));
    expect(await maxNeighbors(server)).toBe(largest);
  });
});
