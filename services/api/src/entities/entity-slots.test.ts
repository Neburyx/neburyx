import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Coordinator, ReadAdmission } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [] })), 'neburyx.yaml');

/** A coordinator over the real slots that counts each admission and can refuse the nth as busy. */
function counting(busyAt?: number) {
  const slots = communitySeams().coordinator;
  let admissions = 0;
  const coordinator: Coordinator = {
    acquireRead: (request): Promise<ReadAdmission> => {
      admissions += 1;
      return admissions === busyAt ? Promise.resolve({ status: 'busy' }) : slots.acquireRead(request);
    },
  };
  return { coordinator, admissions: () => admissions };
}

async function started(busyAt?: number) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, () => Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'W-1' })))));
  const counted = counting(busyAt);
  const defaults = communitySeams();
  const seams = { policy: defaults.policy, coordinator: counted.coordinator, audit: defaults.audit };
  const parts = testSourceGate(mapping, { executor, seams });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams });
  return { app, executor, admissions: counted.admissions };
}

describe('the read slots of an entity load', () => {
  it('take one admission for the schema read and one for the entity read', async () => {
    const { app, executor, admissions } = await started();
    expect((await app.inject({ method: 'GET', url: '/v1/entities/demo/widget/W-1' })).statusCode).toBe(200);
    expect(executor.calls.map((call) => call.templateId)).toEqual(['schema-indexes', 'entity-load']);
    expect(admissions()).toBe(2);
    await app.close();
  });

  it('answer SOURCE_BUSY and read nothing for the entity when its read finds no slot', async () => {
    const { app, executor } = await started(2);
    const response = await app.inject({ method: 'GET', url: '/v1/entities/demo/widget/W-1' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'SOURCE_BUSY', retryable: true } });
    expect(executor.calls.map((call) => call.templateId)).toEqual(['schema-indexes']);
    await app.close();
  });
});
