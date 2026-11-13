import { rmSync } from 'node:fs';
import { templateRunOkSchema } from '../../../packages/contracts/src/template-run.js';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../services/api/src/app.js';
import { allowlistFromMapping } from '../../../services/api/src/gate/allowlist.js';
import type { ExecuteCall, ExecuteOutcome } from '../../../services/api/src/gate/executor.js';
import { SHARED_ATTRIBUTE_ID } from '../../../services/api/src/gate/templates/shared-attribute.js';
import { SHARED_ATTRIBUTE_COUNT_ID } from '../../../services/api/src/gate/templates/shared-attribute-count.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import { communitySeams } from '../../../services/api/src/seams/community-seams.js';
import { memoryAppStore } from '../../../services/api/src/testing/app-store.js';
import { TestExecutor } from '../../../services/api/src/testing/gate.js';
import { plainNode, plainRelationship } from '../../../services/api/src/testing/normalize-fixtures.js';
import { packMappingText, type Pack } from '../../../services/api/src/testing/pack-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../../../services/api/src/testing/search-fixtures.js';
import { testSourceGate } from '../../../services/api/src/testing/source-gate.js';
import { makeWebRoot } from '../../../services/api/src/testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

interface Layout {
  readonly pack: Pack;
  readonly anchor: string;
  readonly attribute: string;
  readonly via: string;
}

/** The rows a source of the pack answers for a shared-attribute run, built from the pack's own labels and stable ID properties. */
async function started(layout: Layout, matches: readonly string[], flags: { readonly skipped?: boolean } = {}) {
  const mapping = parseMapping(packMappingText(layout.pack), 'neburyx.yaml');
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the pack has no source');
  const allowlist = allowlistFromMapping(source);
  const node = (type: string, id: string) => plainNode([allowlist.entityLabels.get(type) ?? ''], { [allowlist.stableIds.get(type) ?? '']: id });
  const row = (anchorId: string, match: string, attributeId: string) => {
    const [a, b, x] = [node(layout.anchor, anchorId), node(layout.anchor, match), node(layout.attribute, attributeId)];
    const stableId = allowlist.relationshipRows.find((candidate) => candidate.type === layout.via)?.stableId;
    const properties = (id: string) => (stableId === undefined ? {} : { [stableId]: id });
    return { a, skipped: flags.skipped === true, bounded: false, b, xs: [x], ras: [plainRelationship(layout.via, a, x, properties(`${anchorId}-${attributeId}`))], rbs: [plainRelationship(layout.via, b, x, properties(`${match}-${attributeId}`))], shared: 1, evidenceCut: false };
  };
  const rows = matches.map((match) => row('ANCHOR', match, 'SHARED-1'));
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => Promise.resolve({ status: 'rows', rows: call.templateId === SHARED_ATTRIBUTE_COUNT_ID ? [{ matches: matches.length, anchorBounded: false, skipped: flags.skipped === true }] : rows });
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), answer));
  const parts = testSourceGate(mapping, { executor });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams: communitySeams() });
  return { app, executor, sourceId: source.id, anchorType: layout.anchor };
}

let keys = 0;
const run = (started_: Awaited<ReturnType<typeof started>>, id: string, extra: Record<string, unknown> = {}) =>
  started_.app.inject({ method: 'POST', url: `/v1/templates/${id}/run`, payload: { sourceId: started_.sourceId, params: { ref: { entityType: started_.anchorType, stableId: 'ANCHOR' }, ...extra } }, headers: { 'idempotency-key': `pack-key-of-sixteen-${(keys += 1)}` } });
const runs = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === SHARED_ATTRIBUTE_ID);

const RING = ['AC-0002001', 'AC-0002002', 'AC-0002003', 'AC-0002004', 'AC-0002005'];

describe('the presets of the banking pack, run through the route with no code of their own', () => {
  const devices: Layout = { pack: 'banking-fraud', anchor: 'account', attribute: 'device', via: 'USES_DEVICE' };

  it('runs Shared devices from the pack\'s own names: the other accounts of a ring are the matches, never the anchor', async () => {
    const rig = await started(devices, RING);
    const body = templateRunOkSchema.parse((await run(rig, 'shared-devices')).json());
    expect(body).toMatchObject({ presetId: 'shared-devices', templateId: 'shared-attribute', count: { value: 5, quality: 'exact' } });
    expect(body.matchIds.map((ref) => ref.stableId).sort()).toEqual(RING);
    expect(body.matchIds.map((ref) => ref.stableId)).not.toContain('ANCHOR');
    const [call] = runs(rig.executor);
    expect(call?.cypher).toContain('`USES_DEVICE`');
    expect(call?.cypher).toContain('`isShared`');
    expect(call?.cypher).not.toContain('ANCHOR');
    await rig.app.close();
  });

  it('says a stop-listed attribute was skipped and still returns the matches through the others', async () => {
    const rig = await started({ ...devices, attribute: 'ip_address', via: 'CONNECTS_FROM' }, RING, { skipped: true });
    const body = templateRunOkSchema.parse((await run(rig, 'shared-addresses')).json());
    expect(body.notices).toEqual([{ code: 'stopListSkipped' }]);
    expect(body.matchIds).toHaveLength(5);
    await rig.app.close();
  });

  it('answers a lower bound of the limit when the run found one match more', async () => {
    const rig = await started(devices, [...RING.slice(0, 3), 'AC-9', 'AC-10']);
    const body = templateRunOkSchema.parse((await run(rig, 'shared-devices', { limit: 3 })).json());
    expect(body.count).toMatchObject({ value: 3, quality: 'lowerBound' });
    await rig.app.close();
  });

  it('accepts a window on the time property the pack maps for the relationship type', async () => {
    const rig = await started(devices, RING);
    expect((await run(rig, 'shared-devices', { window: { days: 30 } })).statusCode).toBe(200);
    expect(runs(rig.executor)[0]?.cypher).toContain('`lastSeen`');
    await rig.app.close();
  });
});

describe('the preset of the insurance pack', () => {
  const addresses: Layout = { pack: 'insurance-claims', anchor: 'claimant', attribute: 'address', via: 'LIVES_AT' };

  it('runs Shared addresses with no code, says there is no stop list over the types, and shows the records as aggregate edges whose count is a lower bound', async () => {
    const rig = await started(addresses, ['CL-2', 'CL-3']);
    const body = templateRunOkSchema.parse((await run(rig, 'shared-addresses')).json());
    expect(body.matchIds.map((ref) => ref.stableId).sort()).toEqual(['CL-2', 'CL-3']);
    expect(body.notices).toEqual([{ code: 'noStopList' }]);
    const aggregates = body.edges.filter((edge) => 'aggregate' in edge.ref);
    expect(aggregates.length).toBeGreaterThan(0);
    for (const edge of aggregates) expect(edge.memberCount?.quality).toBe('lowerBound');
    await rig.app.close();
  });

  it('refuses a window, because the pack maps no time property for the relationship type', async () => {
    const rig = await started(addresses, ['CL-2']);
    expect((await run(rig, 'shared-addresses', { window: { days: 30 } })).statusCode).toBe(400);
    expect(runs(rig.executor)).toHaveLength(0);
    await rig.app.close();
  });
});
