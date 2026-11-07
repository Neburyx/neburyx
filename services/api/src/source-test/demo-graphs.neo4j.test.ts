import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { forwardTo, type Forwarder } from '@neburyx/test-neo4j';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { parseMapping } from '../mapping/load.js';
import type { SourceModel } from '../mapping/model.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { NEO4J_SERIES, runAdmin, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { createSourceTester } from './tester.js';

// The demo graph tool is a developer tool that the product may not import (a workspace check forbids it, tests included),
// so the graphs are built the way a person builds them: by running its command line as a child process.
const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const image = NEO4J_SERIES;
const TOOL = join(repoRoot, 'tools', 'demo-graph', 'dist', 'main.js');
const PACKS = ['banking-fraud', 'insurance-claims'] as const;
const servers = new Map<string, RunningNeo4j>();
const forwarders: Forwarder[] = [];
const folder = mkdtempSync(join(tmpdir(), 'demo-graphs-neo4j-'));
const gates: SourceGate[] = [];

const quote = (name: string): string => `\`${name}\``;

/** The mapping of a pack with the database of this run in place of the default one, written where the tool can read it; the packs themselves are not changed. */
function mappingOf(pack: string, server: RunningNeo4j): string {
  const text = readFileSync(join(repoRoot, 'domain-packs', pack, 'neburyx.yaml'), 'utf8').replace(/^(\s*database:\s*)neo4j\s*$/m, `$1${server.database}`);
  if (!text.includes(`database: ${server.database}`)) throw new Error(`the ${pack} mapping does not name the default database`);
  const file = join(folder, `${pack}.yaml`);
  writeFileSync(file, text);
  return file;
}

beforeAll(async () => {
  await run('pnpm', ['--filter', '@neburyx/demo-graph', 'build'], { cwd: repoRoot });
  const started = await Promise.all(PACKS.map(async (pack) => [pack, await startNeo4j()] as const));
  for (const [pack, server] of started) servers.set(pack, server);
  for (const [pack, server] of started) {
    // the tool loads only to a loopback address or a one-word host, so it reaches the dev server through a forwarder on the loopback
    const forwarder = await forwardTo(server.boltUri);
    forwarders.push(forwarder);
    const definition = join(repoRoot, 'domain-packs', pack, 'demo.yaml');
    await run('node', [TOOL, 'build', '--mapping', mappingOf(pack, server), '--definition', definition, '--uri', forwarder.uri], { cwd: repoRoot, env: { ...process.env, DEMO_NEO4J_USER: server.user, DEMO_NEO4J_PASSWORD: server.password } });
    await runAdmin(server, 'CALL db.awaitIndexes(120)');
  }
}, 600_000);

afterAll(async () => {
  await runAll([...gates.map((gate) => () => gate.close()), ...forwarders.map((forwarder) => () => forwarder.close()), ...[...servers.values()].map((server) => () => server.stop())]);
  rmSync(folder, { recursive: true, force: true });
});

function sourceOf(pack: string): SourceModel {
  const server = servers.get(pack);
  if (server === undefined) throw new Error(`no server for ${pack}`);
  const text = readFileSync(mappingOf(pack, server), 'utf8').replace(/uri: "[^"]+"/, `uri: "${server.boltUri}"`);
  const [source] = parseMapping(text, 'neburyx.yaml').sources;
  if (source === undefined) throw new Error(`the ${pack} pack has no source`);
  return source;
}

async function report(pack: string) {
  const server = servers.get(pack);
  const source = sourceOf(pack);
  if (server === undefined) throw new Error(`no server for ${pack}`);
  const mapping = { sources: [source] };
  const gate = createSourceGate({ mapping, env: { DEMO_NEO4J_USER: server.reader.user, DEMO_NEO4J_PASSWORD: server.reader.password }, seams: communitySeams(), logger: { warn: () => undefined } });
  gates.push(gate);
  return createSourceTester({ gate: gate.gate, mapping, store: memoryAppStore() }).run({ traceId: 'tr-demo', principal: LOCAL_PRINCIPAL, sourceId: source.id });
}

/** The name of the index or constraint that the tool made on a label (or relationship type) and a property. */
async function schemaNameOf(server: RunningNeo4j, kind: 'NODE' | 'RELATIONSHIP', name: string, property: string): Promise<{ index: string; constraint: string | null }> {
  const session = server.admin.session({ database: server.database });
  try {
    const indexes = await session.run('SHOW INDEXES YIELD name, entityType, labelsOrTypes, properties, owningConstraint WHERE entityType = $kind AND labelsOrTypes = [$name] AND properties = [$property] RETURN name, owningConstraint', { kind, name, property });
    const row = indexes.records[0];
    if (row === undefined) throw new Error(`no index on ${name}.${property}`);
    return { index: String(row.get('name')), constraint: row.get('owningConstraint') === null ? null : String(row.get('owningConstraint')) };
  } finally {
    await session.close();
  }
}

describe.each(PACKS)(`the %s pack against ${image}`, (pack) => {
  it('fits the graph that the tool builds: every mapping check passes', async () => {
    const found = await report(pack);
    expect(found.mappingChecks).toEqual({ status: 'pass', findings: [] });
    expect(found).toMatchObject({ outcome: 'pass', state: 'connected', stateReason: null });
  });

  it('answers every count of neighbors from the degree, supernodes included: each type is cheap, none timed out or was skipped, and the version is the image\'s', async () => {
    const found = await report(pack);
    const mapped = sourceOf(pack);
    const withRelationship = new Set(mapped.relationships.flatMap((relationship) => [relationship.from, relationship.to]));
    expect(found.degreeChecks.status).toBe('pass');
    expect(found.degreeChecks.warnings).toEqual([]);
    expect(found.degreeChecks.types.map((entry) => entry.entityType).sort()).toEqual([...withRelationship].sort());
    expect(found.degreeChecks.types.every((entry) => entry.result === 'cheap' && entry.basis === 'degree-operator')).toBe(true);
    expect(found.degreeChecks.foundOn).toBe(`Neo4j ${found.server?.version}`);
    expect(found).toMatchObject({ outcome: 'pass', state: 'connected' });
  });

  it('no longer fits once a constraint or an index that the tool made is dropped: the matching finding appears, and restoring it brings the pass back', async () => {
    const server = servers.get(pack);
    if (server === undefined) throw new Error('no server');
    const source = sourceOf(pack);
    const dropped: { statement: string; expected: string }[] = [];
    try {
      // the unique constraint (and the index that backs it) of the first entity type
      const entity = source.entities[0];
      if (entity === undefined) throw new Error('no entity');
      const stable = await schemaNameOf(server, 'NODE', entity.label, entity.stableId);
      expect(stable.constraint).not.toBeNull();
      await runAdmin(server, `DROP CONSTRAINT ${quote(stable.constraint ?? '')}`);
      dropped.push({ statement: `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${quote(entity.label)}) REQUIRE n.${quote(entity.stableId)} IS UNIQUE`, expected: 'stable-id-unindexed' });
      expect((await report(pack)).mappingChecks.findings.map((finding) => finding.check)).toContain('stable-id-unindexed');
      await runAdmin(server, dropped[0]?.statement ?? '');
      await runAdmin(server, 'CALL db.awaitIndexes(120)');

      // a search, a reference and an evidence index, one at a time, wherever the pack has one
      const cases: { check: string; kind: 'NODE' | 'RELATIONSHIP'; name: string; property: string }[] = [];
      for (const candidate of source.entities) {
        const search = candidate.search.find((property) => property !== candidate.stableId);
        if (search !== undefined && !cases.some((entry) => entry.check === 'search-index')) cases.push({ check: 'search-index', kind: 'NODE', name: candidate.label, property: search });
        const reference = candidate.reference[0];
        if (reference !== undefined && !cases.some((entry) => entry.check === 'reference-index')) cases.push({ check: 'reference-index', kind: 'NODE', name: candidate.label, property: reference });
      }
      for (const relationship of source.relationships) {
        const evidence = relationship.evidence[0];
        if (evidence !== undefined && !cases.some((entry) => entry.check === 'evidence-index')) cases.push({ check: 'evidence-index', kind: 'RELATIONSHIP', name: relationship.type, property: evidence });
      }
      expect(cases.length).toBeGreaterThan(0);
      for (const entry of cases) {
        const names = await schemaNameOf(server, entry.kind, entry.name, entry.property);
        await runAdmin(server, `DROP INDEX ${quote(names.index)}`);
        const target = entry.kind === 'NODE' ? `(n:${quote(entry.name)}) ON (n.${quote(entry.property)})` : `()-[r:${quote(entry.name)}]-() ON (r.${quote(entry.property)})`;
        try {
          const found = await report(pack);
          expect(found.mappingChecks.findings.map((finding) => [finding.check, finding.property])).toContainEqual([entry.check, entry.property]);
          expect(found).toMatchObject({ outcome: 'fail', state: 'unavailable' });
        } finally {
          await runAdmin(server, `CREATE INDEX IF NOT EXISTS FOR ${target}`);
          await runAdmin(server, 'CALL db.awaitIndexes(120)');
        }
      }
      expect((await report(pack)).mappingChecks).toEqual({ status: 'pass', findings: [] });
    } finally {
      for (const entry of dropped) await runAdmin(server, entry.statement);
      await runAdmin(server, 'CALL db.awaitIndexes(120)');
    }
  });
});
