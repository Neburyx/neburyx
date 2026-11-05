import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import neo4j from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import type { Value } from './rules.js';
import { readExport } from './validate.js';
import { numberOf, query, startNeo4j, type RunningNeo4j } from './testing/container.js';
import { scratch } from './testing/export-helpers.js';
import { readManifest } from './testing/records.js';
import { miniDefinitionPath, miniMappingPath } from './testing/fixture.js';

let server: RunningNeo4j;
let env: Record<string, string>;
let mappingPath: string | undefined;

/** The mini mapping with the database of this run in place of the default one: the tool builds into the database the mapping names. */
function mappingFile(): string {
  if (mappingPath === undefined) {
    const text = readFileSync(miniMappingPath, 'utf8').replace(/^(\s*database:\s*)neo4j\s*$/m, `$1${server.database}`);
    if (!text.includes(`database: ${server.database}`)) throw new Error('the mini mapping does not name the default database');
    mappingPath = join(scratch(), 'neburyx.yaml');
    writeFileSync(mappingPath, text);
  }
  return mappingPath;
}

beforeAll(async () => {
  server = await startNeo4j();
  env = { MINI_USER: server.user, MINI_PASSWORD: server.password };
});

afterAll(async () => {
  await server?.stop();
});

async function build(extra: string[], directory = join(scratch(), 'export')): Promise<{ code: number; err: string; directory: string }> {
  const err: string[] = [];
  const code = await runCli(['build', '--mapping', mappingFile(), '--definition', miniDefinitionPath, '--uri', server.boltUri, '--out', directory, ...extra], { out: () => undefined, err: (text) => err.push(text), env });
  return { code, err: err.join('\n'), directory };
}

async function schemaSize(): Promise<number> {
  const constraints = await query(server, 'SHOW CONSTRAINTS YIELD name RETURN count(*) AS found');
  const indexes = await query(server, 'SHOW INDEXES YIELD name RETURN count(*) AS found');
  return numberOf(constraints[0]?.['found']) * 1000 + numberOf(indexes[0]?.['found']);
}

describe('build into a Neo4j container', () => {
  let first: Awaited<ReturnType<typeof build>>;
  beforeAll(async () => {
    first = await build([]);
  });

  it('loads exactly the counts of the manifest', async () => {
    expect(first.code, first.err).toBe(0);
    const manifest = readManifest(first.directory);
    for (const file of manifest.files) {
      const cypher = file.kind === 'entity' ? `MATCH (n:\`${file.label}\`) RETURN count(n) AS found` : `MATCH ()-[r:\`${file.type}\`]->() RETURN count(r) AS found`;
      const rows = await query(server, cypher);
      expect(numberOf(rows[0]?.['found'])).toBe(file.count);
    }
  });

  it('keeps the types: a 64-bit integer beyond the safe range, a float, a date and a date-time', async () => {
    const [gadget] = await query(server, 'MATCH (g:Gadget) WHERE g.gadgetId = "G000" RETURN g.size AS size, g.weight AS weight, g.madeOn AS madeOn, g.serial AS serial');
    expect(neo4j.isInt(gadget?.['size'])).toBe(true);
    expect(typeof gadget?.['weight']).toBe('number');
    expect(neo4j.isDate(gadget?.['madeOn'])).toBe(true);
    expect(neo4j.isInt(gadget?.['serial'])).toBe(true);
    expect(BigInt(String(gadget?.['serial'])) >= 9007199254740993n).toBe(true);
    const seen = await query(server, 'MATCH ()-[r:HAS]->() WHERE r.seenAt IS NOT NULL RETURN r.seenAt AS seenAt LIMIT 1');
    expect(neo4j.isDateTime(seen[0]?.['seenAt'])).toBe(true);
  });

  it('holds exactly the values that were exported: integers as the same text, floats, strings, dates and date-times as the same parts', async () => {
    const exported = readExport(first.directory);
    const check = (loaded: unknown, value: Value): void => {
      if (typeof value !== 'object') {
        expect(loaded).toBe(value);
      } else if ('$int' in value) {
        expect(neo4j.isInt(loaded) && loaded.toString()).toBe(value.$int);
      } else if ('$date' in value) {
        expect(neo4j.isDate(loaded) && `${String(loaded.year).padStart(4, '0')}-${String(loaded.month).padStart(2, '0')}-${String(loaded.day).padStart(2, '0')}`).toBe(value.$date);
      } else {
        const parts = neo4j.isDateTime(loaded) ? [loaded.year, loaded.month, loaded.day, loaded.hour, loaded.minute, loaded.second, loaded.nanosecond, loaded.timeZoneOffsetSeconds] : [];
        expect(parts.map((part) => (neo4j.isInt(part) ? part.toNumber() : part))).toEqual([...(value.$datetime.match(/\d+/g) ?? []).map(Number), 0, 0]);
      }
    };
    const gadgets = await query(server, 'MATCH (g:Gadget) RETURN g');
    const propertiesOfNode = (node: unknown): Record<string, unknown> => (neo4j.isNode(node) ? node.properties : {});
    const loadedById = new Map(gadgets.map((row) => [String(propertiesOfNode(row['g'])['gadgetId']), propertiesOfNode(row['g'])]));
    const exportedGadgets = exported.entities.find((entity) => entity.type === 'gadget')?.rows ?? [];
    expect(loadedById.size).toBe(exportedGadgets.length);
    for (const row of exportedGadgets) {
      const loaded = loadedById.get(String(row['gadgetId']));
      expect(Object.keys(loaded ?? {}).sort()).toEqual(Object.keys(row).sort());
      for (const [key, value] of Object.entries(row)) check(loaded?.[key], value);
    }
    const edges = exported.relationships.find((relationship) => relationship.type === 'HAS')?.rows ?? [];
    const loadedEdges = await query(server, 'MATCH ()-[r:HAS]->() RETURN r.linkId AS id, r.seenAt AS seenAt');
    const seenById = new Map(loadedEdges.map((row) => [String(row['id']), row['seenAt']]));
    for (const edge of edges) {
      const seen = edge.p['seenAt'];
      if (seen === undefined) expect(seenById.get(String(edge.p['linkId']))).toBeNull();
      else check(seenById.get(String(edge.p['linkId'])), seen);
    }
  });

  it('creates the unique constraints and the indexes of the mapping', async () => {
    const constraints = await query(server, 'SHOW CONSTRAINTS YIELD labelsOrTypes, properties, type RETURN labelsOrTypes, properties, type');
    // the server lines name the constraint type differently (UNIQUENESS, NODE_PROPERTY_UNIQUENESS)
    expect(constraints.map((row) => `${String(row['labelsOrTypes'])}:${String(row['properties'])}:${String(row['type']).endsWith('UNIQUENESS') ? 'unique' : String(row['type'])}`).sort()).toEqual(['Gadget:gadgetId:unique', 'Widget:widgetId:unique']);
    const indexes = await query(server, "SHOW INDEXES YIELD labelsOrTypes, properties, type WHERE type <> 'LOOKUP' RETURN labelsOrTypes, properties");
    const listed = indexes.map((row) => `${String(row['labelsOrTypes'])}:${String(row['properties'])}`);
    for (const wanted of ['Widget:colour', 'Gadget:batch', 'HAS:linkId', 'HAS:source', 'HAS:seenAt']) expect(listed).toContain(wanted);
  });

  it('refuses a database that holds nodes and changes nothing, data or schema, and clears and reloads with the reset flag', async () => {
    const before = await schemaSize();
    const countBefore = await query(server, 'MATCH (n) RETURN count(n) AS found');
    const refused = await build([]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('already holds nodes');
    expect(await schemaSize()).toBe(before);
    expect(await query(server, 'MATCH (n) RETURN count(n) AS found')).toEqual(countBefore);
    const reloaded = await build(['--reset', '--seed', '9']);
    expect(reloaded.code, reloaded.err).toBe(0);
    expect(numberOf((await query(server, 'MATCH (n:Widget) RETURN count(n) AS found'))[0]?.['found'])).toBe(50);
  });
});
