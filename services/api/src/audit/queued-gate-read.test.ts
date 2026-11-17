import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '@neburyx/contracts';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TestExecutor, TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { createAuditQueue } from './queue.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [], budgets: { requests_per_minute: 60 } })), 'neburyx.yaml');

async function started(sink: { record(event: AuditEvent): Promise<void> }) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink }], settings: { queueSize: 10, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 1000 }, logger: { warn: () => undefined } });
  const defaults = communitySeams();
  const seams: Seams = { ...defaults, audit: queue.sink };
  const executor = new TestExecutor(
    withSchema(() => schemaAnswer(onlineIndexesOf(source)), async (call) => (call.templateId === 'entity-load-many' ? { status: 'rows' as const, rows: [{ i: 0, n: plainNode(['Widget'], { widgetId: 'W-1' }, '4:s:W-1'), dup: false }] } : { status: 'rows' as const, rows: [] })),
  );
  const parts = testSourceGate(mapping, { executor, seams, referenceKeys: TEST_REFERENCE_KEYS });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams, referenceKeys: TEST_REFERENCE_KEYS });
  return { app, queue };
}

const read = (app: Awaited<ReturnType<typeof started>>['app']) => app.inject({ method: 'POST', url: '/v1/graph/read-refs', payload: { sourceId: 'demo', entities: [{ sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }] } });

describe('a read through the gate with the audit sink held open', () => {
  it('is answered with its normal result before the sink is released, and its event reaches the sink after', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const { app, queue } = await started({
      async record(event) {
        seen.push(event.action);
        await gate;
      },
    });
    const response = await read(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ nodes: [{ ref: { stableId: 'W-1' } }] });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(queue.counts().queued).toBeGreaterThan(1);
    release();
    await vi.waitFor(() => expect(queue.counts()).toMatchObject({ queued: 0, failed: 0, dropped: 0 }));
    expect(seen).toContain('entity.load');
    await app.close();
  });

  it('is answered with its normal result when the sink fails every write', async () => {
    const { app, queue } = await started({ record: () => Promise.reject(new Error('down')) });
    const response = await read(app);
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(queue.counts().failed).toBeGreaterThan(0));
    await app.close();
  });
});
