import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { assembleGate } from '../gate/assemble.js';
import { createTemplateCatalog, type TemplateDefinition } from '../gate/catalog.js';
import type { SystemRunner } from '../gate/types.js';
import type { SourceModel } from '../mapping/model.js';
import { communitySeams } from '../seams/community-seams.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';
import { envFor, runAdmin, startNeo4j, type RunningNeo4j } from './neo4j-container.js';
import { PACKS, packSource, repoRoot, type Pack } from './pack-fixtures.js';
import { ALWAYS_USABLE } from './usability.js';

// The demo graph tool is a developer tool that the product may not import, so the graphs are built the way a person builds them: by running its command line.
const run = promisify(execFile);
const TOOL = join(repoRoot, 'tools', 'demo-graph', 'dist', 'main.js');

const captureTemplate = (id: string, cypher: string, entityParams: string[], relationshipParams: string[], params: Record<string, z.ZodString>): TemplateDefinition => ({
  id,
  version: '1',
  auditAction: `test.${id}`,
  cypher,
  paramsSchema: z.strictObject(params),
  scope: 'system',
  paged: false,
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
  captureTemplate('capture-made', "MATCH (n) WHERE n.zzMarker IN ['m1', 'm2', 'm3'] RETURN n ORDER BY n.zzMarker", [], [], {}),
  captureTemplate('capture-members', 'MATCH (a)-[r]->(b) WHERE r.zzMarker IS NOT NULL RETURN a, r, b ORDER BY r.zzMarker', [], [], {}),
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
  close(): Promise<void>;
}

/** Starts a container for each pack, builds the pack's demo graph in it with the tool's command line, and opens a gate over it with the capture templates. */
export async function startPackServers(): Promise<PackServer[]> {
  await run('pnpm', ['--filter', '@neburyx/demo-graph', 'build'], { cwd: repoRoot });
  const started = await Promise.all(PACKS.map(async (pack) => ({ pack, server: await startNeo4j() })));
  const opened: PackServer[] = [];
  for (const { pack, server } of started) {
    await run('node', [TOOL, 'build', '--pack', pack, '--uri', server.boltUri], { cwd: repoRoot, env: { ...process.env, DEMO_NEO4J_USER: server.user, DEMO_NEO4J_PASSWORD: server.password } });
    await runAdmin(server, 'CALL db.awaitIndexes(120)');
    const source = packSource(pack, server.boltUri);
    const mapping = { sources: [source] };
    const executor: Neo4jExecutor = createNeo4jExecutor({ sources: mapping.sources, env: { DEMO_NEO4J_USER: server.user, DEMO_NEO4J_PASSWORD: server.password, ...envFor(server) }, logger: { warn: () => undefined } });
    const defaults = communitySeams();
    const { system } = assembleGate({
      usability: ALWAYS_USABLE,
      mapping,
      seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit },
      executor,
      logger: { warn: () => undefined },
      catalog: createTemplateCatalog({ templates: CAPTURE_TEMPLATES }),
    });
    opened.push({ pack, server, source, system, close: () => executor.close() });
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
  const session = target.server.admin.session({ database: 'neo4j' });
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
