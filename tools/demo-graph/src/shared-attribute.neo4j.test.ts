import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templateRunResponseSchema } from '../../../packages/contracts/src/template-run.js';
import { buildApp } from '../../../services/api/src/app.js';
import { allowlistFromMapping } from '../../../services/api/src/gate/allowlist.js';
import { createSourceGate, type SourceGate } from '../../../services/api/src/gate/source-gate.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import { communitySeams } from '../../../services/api/src/seams/community-seams.js';
import { memoryAppStore } from '../../../services/api/src/testing/app-store.js';
import { packMappingText } from '../../../services/api/src/testing/pack-fixtures.js';
import { makeWebRoot } from '../../../services/api/src/testing/web-root.js';
import { readCases } from './cases.js';
import { readDefinition } from './definition.js';
import { writeExport } from './export.js';
import { generate } from './generate.js';
import { loadExport } from './load.js';
import { readMappingSource } from './mapping.js';
import { packFiles } from './packs.js';
import { query, startNeo4j, type RunningNeo4j } from './testing/container.js';
import { scratch } from './testing/export-helpers.js';

const files = packFiles('banking-fraud');
const webRoot = makeWebRoot();
let server: RunningNeo4j;
let parts: SourceGate;
let app: Awaited<ReturnType<typeof buildApp>>;
let accountOnStopList = '';
let presetAccount = '';

const ENV_USER = 'DEMO_RUN_USER';
const ENV_PASSWORD = 'DEMO_RUN_PASSWORD';
const ring = ['AC-0002000', 'AC-0002001', 'AC-0002002', 'AC-0002003', 'AC-0002004', 'AC-0002005'];

beforeAll(async () => {
  const mapping = readMappingSource(files.mapping);
  const definition = readDefinition(files.definition, mapping);
  const directory = join(scratch(), 'export');
  writeExport(directory, generate(mapping, definition, definition.seed));
  presetAccount = readCases(files.cases, mapping, definition).preset.entity.id;
  server = await startNeo4j();
  await loadExport({ directory, source: { ...mapping, database: server.database }, override: server.boltUri, env: { [mapping.usernameEnv]: server.user, [mapping.passwordEnv]: server.password }, reset: false });
  const text = packMappingText('banking-fraud', server.boltUri, server.database).replace(/username_env: [A-Z0-9_]+/, `username_env: ${ENV_USER}`).replace(/password_env: [A-Z0-9_]+/, `password_env: ${ENV_PASSWORD}`);
  const model = parseMapping(text, 'neburyx.yaml');
  const [source] = model.sources;
  if (source === undefined) throw new Error('the pack has no source');
  const allowlist = allowlistFromMapping(source);
  const [accountLabel, accountId, deviceLabel, deviceId] = [allowlist.entityLabels.get('account'), allowlist.stableIds.get('account'), allowlist.entityLabels.get('device'), allowlist.stableIds.get('device')];
  const rows = await query(server, `MATCH (a:\`${accountLabel}\`)-[:USES_DEVICE]->(d:\`${deviceLabel}\` {\`${deviceId}\`: 'DV-000000'}) RETURN a.\`${accountId}\` AS id LIMIT 1`);
  accountOnStopList = String(rows[0]?.['id'] ?? '');
  const defaults = communitySeams();
  parts = createSourceGate({ mapping: model, env: { [ENV_USER]: server.user, [ENV_PASSWORD]: server.password }, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
  app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping: model, gate: parts.gate, seams: communitySeams() });
  await app.ready();
}, 900_000);

afterAll(async () => {
  await app?.close();
  await parts?.close();
  await server?.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

let keys = 0;
async function run(preset: string, stableId: string, extra: Record<string, unknown> = {}) {
  const response = await app.inject({ method: 'POST', url: `/v1/templates/${preset}/run`, payload: { sourceId: 'banking-demo', params: { ref: { entityType: 'account', stableId }, ...extra } }, headers: { 'idempotency-key': `demo-key-of-sixteen-${(keys += 1)}` } });
  expect(response.statusCode, response.body).toBe(200);
  return templateRunResponseSchema.parse(response.json());
}

describe('the Shared devices and Shared addresses presets of the banking pack on its demo graph, through the run route', () => {
  it('uses the account the pack names for its preset', () => {
    expect(presetAccount).toBe('AC-0002000');
  });

  it('returns, from the preset account, the other five accounts of the ring on one device, and not the account itself', async () => {
    const body = await run('shared-devices', 'AC-0002000');
    const found = body.matchIds.map((ref) => ref.stableId);
    for (const id of ring.slice(1)) expect(found).toContain(id);
    expect(found).not.toContain('AC-0002000');
  });

  it('does not return the thousand accounts of the stop-listed device as a ring, and says it skipped it', async () => {
    expect(accountOnStopList).not.toBe('');
    const body = await run('shared-devices', accountOnStopList);
    expect(body.notices).toContainEqual({ code: 'stopListSkipped' });
    expect(body.count.quality).toBe('exact');
    expect(body.matchIds.length).toBeLessThan(25);
  });

  it('answers a lower bound of three when the limit is three and the ring has more', async () => {
    const body = await run('shared-devices', 'AC-0002000', { limit: 3 });
    expect(body.matchIds).toHaveLength(3);
    expect(body.count).toMatchObject({ value: 3, quality: 'lowerBound' });
  });

  it('returns the ring mates through the ring\'s own address, from an account that is also on the stop-listed gateway address', async () => {
    const body = await run('shared-addresses', 'AC-0002000');
    const found = body.matchIds.map((ref) => ref.stableId);
    for (const id of ring.slice(1)) expect(found).toContain(id);
    expect(found).not.toContain('AC-0002000');
    expect(body.notices).toContainEqual({ code: 'stopListSkipped' });
  });
});
