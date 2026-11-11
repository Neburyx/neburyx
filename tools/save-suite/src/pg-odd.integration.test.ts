import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAX_REFERENCE_VALUE_CHARACTERS } from '@neburyx/contracts';
import { NOT_READ_FLAG } from '../../../apps/web/src/draft/unmapped.js';
import { decodeStored } from '../../../services/api/src/reference/stored-text.js';
import { identityHashOf } from '../../../services/api/src/registry/identity-hash.js';
import { reportFromServer } from '../../../services/api/src/source-test/report.js';
import { runCli } from '../../../services/api/src/testing/cli.js';
import { baseSource, fileOf } from '../../../services/api/src/testing/mapping.js';
import { startPostgres, type TestPostgres } from '../../../services/api/src/testing/postgres.js';
import { AUTOSAVE_DELAY_MS, closePgStores, ENTITY_TYPES, mappingOf, ref, RELATIONSHIP_TYPES, SOURCE, startPgSuite, World, type PgSuite } from './rig.js';
import { arranged, LINKED, ODD_IDS } from './scenarios.js';

const folder = mkdtempSync(join(tmpdir(), 'save-suite-pg-'));
let postgres: TestPostgres;
let suite: PgSuite | undefined;
beforeAll(async () => {
  postgres = await startPostgres();
});
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});
afterAll(async () => {
  await closePgStores();
  await postgres.stop();
  rmSync(folder, { recursive: true, force: true });
});

describe('identifiers a database cannot hold as they are, on real Postgres', () => {
  it('are stored, read back and reopened as the person had them, with no database error', async () => {
    const world = new World().entity('hub', 'H-1');
    ODD_IDS.forEach((leaf, at) => world.entity('leaf', leaf).relationship('LINKED', ['hub', 'H-1'], ['leaf', leaf], `r-${at}`));
    suite = await startPgSuite(postgres, { world });
    const before = suite.tab();
    await before.open(ref('hub', 'H-1'));
    const id = before.state.investigation.getState().id ?? '';
    await before.load(ODD_IDS.map((leaf) => ref('leaf', leaf)), ODD_IDS.map((_leaf, at) => LINKED(`r-${at}`)));
    before.state.presentation.setPositions(new Map(ODD_IDS.map((leaf, at) => [before.nodeKey('leaf', leaf), { x: at, y: at }] as const)));
    await suite.advance(AUTOSAVE_DELAY_MS);
    await before.written();
    const after = suite.tab();
    expect(await after.openById(id)).toMatchObject({ kind: 'shown', id });
    expect(after.canonical()).toBe(before.canonical());
    const stored = (await suite.draft())?.layout.nodes.map((node) => node.id) ?? [];
    expect(stored.some((each) => each.includes('\u0000'))).toBe(false);
    expect(stored.map(decodeStored).sort()).toEqual(['H-1', ...ODD_IDS].sort());
    expect(after.bodies.filter((text) => text.includes('INTERNAL_ERROR'))).toEqual([]);
  });

  it('are stored in their encoded form for the largest length the contract takes, and read back whole', async () => {
    const longId = 'z'.repeat(MAX_REFERENCE_VALUE_CHARACTERS);
    suite = await startPgSuite(postgres, { world: new World().entity('hub', longId) });
    const before = suite.tab();
    expect(await before.open(ref('hub', longId))).toMatchObject({ kind: 'shown' });
    const id = before.state.investigation.getState().id ?? '';
    before.state.presentation.setPositions(new Map([[before.nodeKey('hub', longId), { x: 1, y: 2 }]]));
    await suite.advance(AUTOSAVE_DELAY_MS);
    await before.written();
    const after = suite.tab();
    expect(await after.openById(id)).toMatchObject({ kind: 'shown', id });
    expect(after.state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual([longId]);
    const [row] = await suite.sql(`SELECT jsonb_array_length(layout->'nodes') AS n FROM saved_views WHERE kind = 'draft'`);
    expect(row?.['n']).toBe(1);
  });
});

describe('a re-pointed source and the real rebind command, on real Postgres', () => {
  it('makes no read of the source before the rebind and opens the investigation normally after it', async () => {
    suite = await startPgSuite(postgres);
    const { id, tab } = await arranged(suite);
    tab.dispose();
    const next = mappingOf({ database: 'a-different-database' });
    await suite.restart(next);
    const reads = suite.executor.calls.length;
    const refused = suite.tab();
    expect(await refused.openById(id)).toMatchObject({ kind: 'shown', id });
    expect(refused.state.investigation.getState().record).toMatchObject({ readOnly: true, sourceState: 'repointed' });
    expect(refused.state.loadedGraph().nodes.every((node) => node.qualityFlags.includes(NOT_READ_FLAG))).toBe(true);
    expect(suite.executor.calls.length).toBe(reads);
    expect(refused.sourceReads()).toEqual([]);

    const [source] = next.sources;
    if (source === undefined) throw new Error('the mapping has a source');
    await suite.store.recordSourceCheck({ id: '0192f000-0000-7000-8000-0000000000a1', report: reportFromServer(source, { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] }, false, '2026-11-10T10:00:00.000Z'), triggeredBy: null, identityHash: identityHashOf(source), configHash: source.configHash });
    const file = join(folder, 'neburyx.yaml');
    writeFileSync(file, fileOf(baseSource({ id: SOURCE, database: 'a-different-database', entities: ENTITY_TYPES, relationships: RELATIONSHIP_TYPES })));
    const done = await runCli(['source', 'rebind', SOURCE, '--confirm', SOURCE], { DATABASE_URL: suite.database.appUrl, NEBURYX_CONFIG: file }).done;
    expect({ code: done.code, stdout: done.stdout, stderr: done.stderr }).toEqual({ code: 0, stdout: 'Source: demo\nInvestigations rebound: 1\n', stderr: '' });

    const opened = suite.tab();
    expect(await opened.openById(id)).toMatchObject({ kind: 'shown', id });
    expect(opened.state.investigation.getState().record).toMatchObject({ readOnly: false, sourceState: 'available' });
    expect(opened.state.loadedGraph().nodes.some((node) => node.qualityFlags.includes(NOT_READ_FLAG))).toBe(false);
  });
});
