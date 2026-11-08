import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { forwardTo } from '@neburyx/test-neo4j';
import { z } from 'zod';
import { assembleGate } from '../gate/assemble.js';
import { createTemplateCatalog, type TemplateDefinition } from '../gate/catalog.js';
import { entityLoadTemplate } from '../gate/templates/entity-load.js';
import { expandNeighborsTemplate } from '../gate/templates/expand-neighbors.js';
import { relatedContextTemplate } from '../gate/templates/related-context.js';
import { schemaIndexesTemplate } from '../gate/templates/schema-indexes.js';
import type { ExecuteCall, ExecuteOutcome, ReadExecutor } from '../gate/executor.js';
import { EXPAND_NEIGHBORS_ID } from '../gate/templates/expand-neighbors.js';
import type { Gate, GatePage, SystemRunner } from '../gate/types.js';
import type { SourceModel } from '../mapping/model.js';
import { communitySeams } from '../seams/community-seams.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';
import { LOCAL_PRINCIPAL } from './gate.js';
import { envFor, runAdmin, startNeo4j, type RunningNeo4j } from './neo4j-server.js';
import { PACKS, packMappingText, packSource, repoRoot, type Pack } from './pack-fixtures.js';

// The demo graph tool is a developer tool that the product may not import, so the graphs are built the way a person builds them: by running its command line.
const run = promisify(execFile);
const TOOL = join(repoRoot, 'tools', 'demo-graph', 'dist', 'main.js');

/** A capture of one row (`LIMIT 1` or a single `RETURN`), or of a few rows, which is a page cut at the limit plus one like any read that returns a list. */
const captureTemplate = (id: string, cypher: string, entityParams: string[], relationshipParams: string[], params: Record<string, z.ZodString>, kind: 'one' | 'list' = 'one'): TemplateDefinition => ({
  id,
  version: '1',
  auditAction: `test.${id}`,
  cypher: kind === 'list' ? `${cypher} LIMIT $limit + 1` : cypher,
  paramsSchema: z.strictObject(params),
  scope: 'system',
  ...(kind === 'list' ? { paged: true } : { paged: false, rows: 'one' as const }),
  entityParams,
  relationshipParams,
  refsOf: () => [],
  // the capture wants the rows exactly as the adapter hands them over
  normalize: (rows) => rows,
});

/** Test-only templates: fixed reads, ordered by stable ID with a fixed limit so that a second capture picks the same records. They are never in the shipped catalog. */
export const CAPTURE_TEMPLATES: readonly TemplateDefinition[] = [
  captureTemplate(
    'capture-values',
    "RETURN 9223372036854775807 AS bigInteger, 7 AS smallInteger, -9007199254740991 AS safeLimit, 1.5 AS decimal, true AS flag, 'text' AS words, null AS nothing, " +
      "date('2026-01-02') AS aDate, datetime('2026-01-02T03:04:05.123456789+02:00') AS aDateTime, localdatetime('2026-01-02T03:04:05') AS aLocalDateTime, " +
      "time('10:11:12Z') AS aTime, localtime('10:11:12') AS aLocalTime, duration('P1Y2M3DT4H5M6S') AS aDuration, point({x: 1.5, y: 2.5}) AS aPoint, " +
      "[1, 'a', null, 9223372036854775807] AS aList, {k: 1, nested: [date('2026-01-02')]} AS aMap LIMIT 1",
    [],
    [],
    {},
  ),
  captureTemplate(
    'capture-path',
    'MATCH p = (a:@entity(entityType))-[r1:@relationship(firstType)]->(b:@entity(middleType))-[r2:@relationship(secondType)]->(c:@entity(lastType)) ' +
      'RETURN p ORDER BY a.@stableId(entityType), b.@stableId(middleType), c.@stableId(lastType), elementId(r1), elementId(r2) LIMIT 1',
    ['entityType', 'middleType', 'lastType'],
    ['firstType', 'secondType'],
    { entityType: z.string(), middleType: z.string(), lastType: z.string(), firstType: z.string(), secondType: z.string() },
  ),
  captureTemplate(
    'capture-supports',
    'MATCH (a:@entity(entityType))-[r1:@relationship(firstType)]->(m:@entity(middleType))<-[r2:@relationship(secondType)]-(b:@entity(lastType)) WHERE a <> b ' +
      'RETURN a, r1, m, r2, b ORDER BY a.@stableId(entityType), b.@stableId(lastType), m.@stableId(middleType), elementId(r1), elementId(r2) LIMIT 1',
    ['entityType', 'middleType', 'lastType'],
    ['firstType', 'secondType'],
    { entityType: z.string(), middleType: z.string(), lastType: z.string(), firstType: z.string(), secondType: z.string() },
  ),
  captureTemplate('capture-made', "MATCH (n) WHERE n.zzMarker IN ['m1', 'm2', 'm3'] RETURN n ORDER BY n.zzMarker", [], [], {}, 'list'),
  captureTemplate('capture-members', 'MATCH (a)-[r]->(b) WHERE r.zzMarker IS NOT NULL RETURN a, r, b ORDER BY r.zzMarker', [], [], {}, 'list'),
  captureTemplate('capture-marked', 'MATCH (n) WHERE n.zzMarker = $marker RETURN n ORDER BY elementId(n)', [], [], { marker: z.string() }, 'list'),
  captureTemplate(
    'capture-relationship',
    'MATCH p = (a:@entity(entityType))-[r:@relationship(relationshipType)]->(b:@entity(otherType)) RETURN a, r, b, p ORDER BY a.@stableId(entityType), b.@stableId(otherType), elementId(r) LIMIT 1',
    ['entityType', 'otherType'],
    ['relationshipType'],
    { entityType: z.string(), otherType: z.string(), relationshipType: z.string() },
  ),
  captureTemplate('capture-node', 'MATCH (n:@entity(entityType)) RETURN n ORDER BY n.@stableId(entityType) LIMIT 1', ['entityType'], [], { entityType: z.string() }),
];

export interface PackServer {
  readonly pack: Pack;
  readonly server: RunningNeo4j;
  readonly source: SourceModel;
  readonly system: SystemRunner;
  /** The user gate over the same source, with the capture templates and the entity read in its catalog. */
  readonly gate: Gate;
  /** The rows the adapter handed to the gate for one expansion of a node, as the real template read them, and the page the gate made of them. */
  expand(params: Record<string, string>, mask?: boolean): Promise<{ readonly rows: readonly Record<string, unknown>[]; readonly page: GatePage }>;
  close(): Promise<void>;
}

/** Makes a database on the dev server for each pack, builds the pack's demo graph in it with the tool's command line, and opens a gate over it with the capture templates. */
export async function startPackServers(): Promise<PackServer[]> {
  await run('pnpm', ['--filter', '@neburyx/demo-graph', 'build'], { cwd: repoRoot });
  const started = await Promise.all(PACKS.map(async (pack) => ({ pack, server: await startNeo4j() })));
  const opened: PackServer[] = [];
  for (const { pack, server } of started) {
    // the tool loads only to a loopback address or a one-word host, so it reaches the dev server through a forwarder on the loopback,
    // and it loads into the database of this run: the pack's mapping with that database in place of the default one
    const forwarder = await forwardTo(server.boltUri);
    const folder = mkdtempSync(join(tmpdir(), 'normalization-capture-'));
    const mapping = join(folder, `${pack}.yaml`);
    writeFileSync(mapping, packMappingText(pack, undefined, server.database));
    try {
      await run('node', [TOOL, 'build', '--mapping', mapping, '--definition', join(repoRoot, 'domain-packs', pack, 'demo.yaml'), '--uri', forwarder.uri], { cwd: repoRoot, env: { ...process.env, DEMO_NEO4J_USER: server.user, DEMO_NEO4J_PASSWORD: server.password } });
    } finally {
      await forwarder.close();
      rmSync(folder, { recursive: true, force: true });
    }
    await runAdmin(server, 'CALL db.awaitIndexes(120)');
    const source = packSource(pack, server.boltUri, server.database);
    const gateMapping = { sources: [source] };
    const executor: Neo4jExecutor = createNeo4jExecutor({ sources: gateMapping.sources, env: { DEMO_NEO4J_USER: server.reader.user, DEMO_NEO4J_PASSWORD: server.reader.password, ...envFor(server) }, logger: { warn: () => undefined } });
    const defaults = communitySeams();
    const recorded: Record<string, unknown>[] = [];
    const recording: ReadExecutor = {
      async execute(call: ExecuteCall): Promise<ExecuteOutcome> {
        const outcome = await executor.execute(call);
        if (call.templateId === EXPAND_NEIGHBORS_ID && outcome.status === 'rows') recorded.push(...outcome.rows);
        return outcome;
      },
    };
    const { gate, system } = assembleGate({
      mapping: gateMapping,
      seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit },
      executor: recording,
      logger: { warn: () => undefined },
      catalog: createTemplateCatalog({ templates: [...CAPTURE_TEMPLATES, entityLoadTemplate, expandNeighborsTemplate, relatedContextTemplate, schemaIndexesTemplate] }),
    });
    const expand = async (params: Record<string, string>, mask = false) => {
      recorded.length = 0;
      const page = await gate.run({ traceId: 'tr-capture', principal: LOCAL_PRINCIPAL, sourceId: source.id, templateId: EXPAND_NEIGHBORS_ID, params: { ...params, direction: 'both', sort: 'observed' }, limit: 10, mask });
      return { rows: [...recorded], page };
    };
    opened.push({ pack, server, source, system, gate, expand, close: () => executor.close() });
  }
  return opened;
}

const quote = (name: string): string => `\`${name}\``;

/** Removes what `makeRecords` makes, whatever state a failed run left behind. */
export async function removeMadeRecords(target: PackServer): Promise<void> {
  await runAdmin(target.server, 'MATCH (n) WHERE n.zzMarker IS NOT NULL DETACH DELETE n');
}

/**
 * Makes three nodes on a demo container, for the shapes the demo graph does not hold: one of the pack's first entity type with no stable ID, one with a label that only
 * the other pack maps, and one with a stable ID and none of the key properties. Their marker is a property no mapping names. The caller removes them.
 */
export async function makeRecords(target: PackServer): Promise<void> {
  const [entity] = target.source.entities;
  if (entity === undefined) throw new Error('the pack has no entity type');
  const own = new Set(target.source.entities.map((candidate) => candidate.label));
  const otherPack = PACKS.find((pack) => pack !== target.pack);
  if (otherPack === undefined) throw new Error('no other pack');
  const foreign = packSource(otherPack).entities.find((candidate) => !own.has(candidate.label));
  if (foreign === undefined) throw new Error('the other pack maps no label of its own');
  const unkeyed = target.source.relationships.find((relationship) => relationship.stableId === undefined);
  const from = target.source.entities.find((candidate) => candidate.type === unkeyed?.from);
  const to = target.source.entities.find((candidate) => candidate.type === unkeyed?.to);
  if (unkeyed === undefined || from === undefined || to === undefined) throw new Error('the pack maps no relationship without a stable ID');
  await removeMadeRecords(target);
  await runAdmin(target.server, `CREATE (:${quote(entity.label)} {zzMarker: 'm1'}), (:${quote(foreign.label)} {zzMarker: 'm2'}), (:${quote(entity.label)} {zzMarker: 'm3', ${quote(entity.stableId)}: 'ZZ-NORM-3'})`);
  // two relationships of a type that has no stable ID between the same two entities: the members of one aggregate
  await runAdmin(
    target.server,
    `CREATE (a:${quote(from.label)} {${quote(from.stableId)}: 'ZZ-NORM-A', zzMarker: 'ma'}), (b:${quote(to.label)} {${quote(to.stableId)}: 'ZZ-NORM-B', zzMarker: 'mb'}), ` +
      `(a)-[:${quote(unkeyed.type)} {zzMarker: 'r1'}]->(b), (a)-[:${quote(unkeyed.type)} {zzMarker: 'r2'}]->(b)`,
  );
}

/** Runs `work` with the made records in place and removes them afterwards, also when `work` fails. */
export async function withMadeRecords<T>(target: PackServer, work: () => Promise<T>): Promise<T> {
  await makeRecords(target);
  try {
    return await work();
  } finally {
    await removeMadeRecords(target);
  }
}

export async function madeRecordCount(target: PackServer): Promise<number> {
  const session = target.server.admin.session({ database: target.server.database });
  try {
    const result = await session.run('MATCH (n) WHERE n.zzMarker IS NOT NULL RETURN count(n) AS found');
    return Number(result.records[0]?.get('found'));
  } finally {
    await session.close();
  }
}

export async function itemsOf(target: PackServer, templateId: string, params: Record<string, string>): Promise<readonly Record<string, unknown>[]> {
  const page = await target.system.run({ traceId: 'tr-capture', sourceId: target.source.id, templateId, params, limit: 10 });
  return page.items;
}
