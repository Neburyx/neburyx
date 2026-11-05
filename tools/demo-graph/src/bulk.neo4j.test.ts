import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { parseDefinition } from './definition.js';
import { writeExport } from './export.js';
import { generate } from './generate.js';
import { loadExport } from './load.js';
import { numberOf, query, startNeo4j, type RunningNeo4j } from './testing/container.js';
import { scratch } from './testing/export-helpers.js';
import { miniDefinitionText, miniMapping } from './testing/fixture.js';

const NEIGHBORS = 100_000;
let server: RunningNeo4j;

beforeAll(async () => {
  server = await startNeo4j();
});

afterAll(async () => {
  await server?.stop();
});

describe('a node with 100,000 neighbors', () => {
  it('loads, and the time of each phase is reported', async ({ annotate }) => {
    const document = parseDocument(miniDefinitionText);
    document.setIn(['entities', 'widget', 'count'], NEIGHBORS);
    document.setIn(['relationships'], [{ type: 'HAS', from: 'widget', to: 'gadget', pattern: 'random', perFrom: { min: 1, max: 1 }, supernodes: [{ to: 0, from: { start: 0, count: NEIGHBORS } }], properties: { linkId: { sequence: { prefix: 'L', width: 7 } }, seenAt: { datetime: { from: '2026-01-01T00:00:00Z', to: '2026-06-30T23:59:59Z' }, missing: 0.1 }, source: { join: ['rec-', { sequence: { width: 7 } }] }, kind: { choice: ['a', 'b'] } } }]);
    const definition = parseDefinition(String(document), miniMapping);
    const directory = join(scratch(), 'export');
    writeExport(directory, generate(miniMapping, definition, 3));
    const report = await loadExport({ directory, source: { ...miniMapping, database: server.database }, override: server.boltUri, env: { MINI_USER: server.user, MINI_PASSWORD: server.password }, reset: false });
    const phases = report.phases.map((phase) => `${phase.name} ${(phase.milliseconds / 1000).toFixed(1)} s`).join(', ');
    await annotate(`${server.image}: ${NEIGHBORS} neighbors loaded in ${(report.totalMilliseconds / 1000).toFixed(1)} s (${phases})`);
    const rows = await query(server, 'MATCH (g:Gadget {gadgetId: "G000"})<-[:HAS]-(w) RETURN count(DISTINCT w) AS neighbors');
    expect(numberOf(rows[0]?.['neighbors'])).toBe(NEIGHBORS);
  });
});
