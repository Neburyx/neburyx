import { rmSync } from 'node:fs';
import { PRESET_TEMPLATES, templateListResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { PATTERN_ID } from '../gate/templates/pattern.js';
import { PATTERN_COUNT_ID } from '../gate/templates/pattern-count.js';
import { createLogger } from '../logger.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TestExecutor } from '../testing/gate.js';
import { patternMappingOf } from '../testing/pattern-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

async function started() {
  const mapping = patternMappingOf();
  const executor = new TestExecutor(() => {
    throw new Error('the source was read');
  });
  const seams = communitySeams();
  const parts = testSourceGate(mapping, { executor });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams, catalog: parts.catalog });
  return { app, executor, parts };
}

describe.each([PATTERN_ID, PATTERN_COUNT_ID])('the %s template, which the gate can run and no route lists or runs', (id) => {
  it('is in the catalog but is not one of the templates a pattern can bind, and is not in the list of templates', async () => {
    const { app, parts } = await started();
    expect(parts.catalog.find(id)).toBeDefined();
    expect((PRESET_TEMPLATES as readonly string[]).includes(id)).toBe(false);
    const response = await app.inject({ method: 'GET', url: '/v1/templates?sourceId=demo' });
    expect(response.statusCode).toBe(200);
    expect(templateListResponseSchema.parse(response.json()).templates.map((template) => template.id)).not.toContain(id);
    await app.close();
  });

  it('is not run by the template route: the id is unknown there, and the source is not read', async () => {
    const { app, executor } = await started();
    const body = { sourceId: 'demo', params: { ref: { entityType: 'maker', stableId: 'A-1' }, steps: [] } };
    const response = await app.inject({ method: 'POST', url: `/v1/templates/${id}/run`, payload: body, headers: { 'idempotency-key': 'a-key-of-sixteen-chars-pattern' } });
    expect(response.statusCode).toBe(404);
    expect(executor.calls.filter((call) => call.templateId === id)).toHaveLength(0);
    await app.close();
  });
});
