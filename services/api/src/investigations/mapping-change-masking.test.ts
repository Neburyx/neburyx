import { rmSync } from 'node:fs';
import { investigationResponseSchema, readRefsResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { LOCAL_IDENTITY, memoryAppStore } from '../testing/app-store.js';
import { TestExecutor, TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { maskValue } from '../gate/redact/mask.js';
import { contentHashOf, initialDraftDocuments } from './draft.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const NAME = 'Ana Silva';
const ID = '0192f000-0000-7000-8000-0000000000c1';

// the mapping as it is now: `ownerName` is personal data; the draft below was written when it was not
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId', title: '{ownerName}', pii: [{ property: 'ownerName', class: 'name' }] }], relationships: [] })), 'neburyx.yaml');
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

async function reopened() {
  const store = memoryAppStore();
  const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
  store.investigations.push({ id: ID, sourceId: 'demo', sourceIdentityHash: identityHashOf(demo), ownerId: LOCAL_IDENTITY.principal.id, title: 'Widget W-1', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-1', status: 'open', closedAt: null, archivedAt: null, createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', version: 1 });
  store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000d1', version: 1, notes: null, ...documents, mappingHash: 'the-mapping-that-was', investigationId: ID, contentHash: contentHashOf(documents) });
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(demo)), (call) => Promise.resolve(call.templateId === 'entity-load' ? { status: 'rows' as const, rows: [{ n: plainNode(['Widget'], { widgetId: 'W-1', ownerName: NAME }, '4:s:W-1') }] } : { status: 'rows' as const, rows: [] })));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { executor, referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
  return app;
}

const readRefs = (app: Awaited<ReturnType<typeof reopened>>, mask: boolean) => app.inject({ method: 'POST', url: '/v1/graph/read-refs', payload: { sourceId: 'demo', ...(mask ? { mask: true } : {}), entities: [{ sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }] } });

describe('a property that became personal data after the draft was saved', () => {
  it('opens with no error, and its values are masked by the existing mask function when the session asks for it', async () => {
    const app = await reopened();
    const opened = await app.inject({ method: 'GET', url: `/v1/investigations/${ID}` });
    expect(opened.statusCode).toBe(200);
    expect(investigationResponseSchema.parse(opened.json()).mappingChange).toEqual({ droppedFilters: [] });
    const masked = readRefsResponseSchema.parse((await readRefs(app, true)).json());
    const value = masked.nodes[0]?.properties.find((property) => property.key === 'ownerName');
    expect(value).toMatchObject({ value: maskValue(NAME, 'name'), masked: true });
    expect(JSON.stringify(masked)).not.toContain(NAME);
    await app.close();
  });

  it('is shown as in any Community read when the session does not ask for masking', async () => {
    const app = await reopened();
    const shown = readRefsResponseSchema.parse((await readRefs(app, false)).json());
    expect(shown.nodes[0]?.properties.find((property) => property.key === 'ownerName')).toMatchObject({ value: NAME, masked: false });
    await app.close();
  });
});
