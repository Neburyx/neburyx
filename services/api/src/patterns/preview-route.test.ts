import { rmSync } from 'node:fs';
import { patternPreviewResponseSchema, patternValidateResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TestExecutor } from '../testing/gate.js';
import { linkedMappingOf } from '../testing/linked-entities-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = linkedMappingOf();

async function started(options: { readonly deny?: boolean } = {}) {
  const executor = new TestExecutor(() => {
    throw new Error('the preview route called the source');
  });
  const events: { action: string; result: string }[] = [];
  const defaults = communitySeams();
  const seams = {
    ...defaults,
    audit: { record: async (event: { action: string; result: string }) => void events.push(event) },
    policy: options.deny === true ? { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } : defaults.policy,
  };
  const parts = testSourceGate(mapping, { executor });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams: seams as never, catalog: parts.catalog });
  return { app, executor, events };
}

type Started = Awaited<ReturnType<typeof started>>;
const post = (app: Started['app'], url: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => app.inject({ method: 'POST', url, payload: typeof body === 'string' ? body : JSON.stringify(body), headers });
const preview = (app: Started['app'], body: unknown, headers?: Record<string, string>) => post(app, '/v1/patterns/preview', body, headers);
const codeOf = (response: { json(): unknown }): unknown => (response.json() as { error?: { code?: unknown } }).error?.code;

const ok = { anchorType: 'maker', steps: [{ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker' }] };

describe('POST /v1/patterns/preview', () => {
  it('answers the preview of a pattern the mapping allows, with the limits of the source, and reads nothing from the source', async () => {
    const { app, executor } = await started();
    const response = await preview(app, { sourceId: 'demo', definition: ok });
    expect(response.statusCode).toBe(200);
    const answer = patternPreviewResponseSchema.parse(response.json());
    expect(answer.status).toBe('ok');
    if (answer.status === 'ok') {
      expect(answer.preview.steps.map((part) => part.text)).toEqual(['Step 1: follow LINKS forward to Maker']);
      expect(answer.preview.bounds.hopLimit.value).toBeGreaterThan(0);
    }
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('answers the problems of the validation, and no preview, when the definition does not validate', async () => {
    const { app } = await started();
    for (const definition of [{ anchorType: 'maker', steps: [{ relationshipTypes: ['NOPE'], direction: 'out', arrivesAt: 'tool' }] }, {}, { anchorType: 'maker', steps: [{ ...ok.steps[0], extra: 1 }] }]) {
      const validated = patternValidateResponseSchema.parse((await post(app, '/v1/patterns/validate', { sourceId: 'demo', definition })).json());
      const previewed = patternPreviewResponseSchema.parse((await preview(app, { sourceId: 'demo', definition })).json());
      expect(previewed).toEqual(validated);
      expect(previewed).not.toHaveProperty('preview');
    }
    await app.close();
  });

  it('refuses a body that is not the envelope, INVALID_REQUEST, and a body that is not JSON, UNSUPPORTED_MEDIA_TYPE', async () => {
    const { app, executor } = await started();
    for (const body of [{ definition: ok }, { sourceId: 'demo' }, { sourceId: 'demo', definition: [] }, { sourceId: 'demo', definition: ok, mask: 'yes' }, { sourceId: 'demo', definition: ok, other: 1 }]) {
      expect(codeOf(await preview(app, body)), JSON.stringify(body)).toBe('INVALID_REQUEST');
    }
    expect(codeOf(await preview(app, '{"sourceId": "demo", "definition": '))).toBe('INVALID_REQUEST');
    expect(codeOf(await preview(app, { sourceId: 'demo', definition: { anchorType: 'x'.repeat(1_100_000), steps: [] } }))).toBe('INVALID_REQUEST');
    expect(codeOf(await preview(app, JSON.stringify({ sourceId: 'demo', definition: ok }), { 'content-type': 'application/xml' }))).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect((await app.inject({ method: 'POST', url: '/v1/patterns/preview?x=1', payload: JSON.stringify({ sourceId: 'demo', definition: ok }), headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('answers NOT_FOUND for a source that is not configured and for one the person may not read, audits the denial as pattern.preview, and puts no value of the request in an answer', async () => {
    const { app } = await started();
    const unknown = await preview(app, { sourceId: 'SENTINEL-SOURCE', definition: ok });
    expect(codeOf(unknown)).toBe('NOT_FOUND');
    expect(unknown.body).not.toContain('SENTINEL-SOURCE');
    const denied = await started({ deny: true });
    expect(codeOf(await preview(denied.app, { sourceId: 'demo', definition: ok }))).toBe('NOT_FOUND');
    expect(denied.events).toEqual([expect.objectContaining({ action: 'pattern.preview', result: 'denied' })]);
    expect(denied.executor.calls).toEqual([]);
    await app.close();
    await denied.app.close();
  });

  it('puts no value of the definition in an answer that carries problems', async () => {
    const { app } = await started();
    const sentinel = 'SENTINEL-DEFINITION';
    const response = await preview(app, { sourceId: 'demo', definition: { anchorType: sentinel, steps: [{ relationshipTypes: [sentinel], direction: sentinel, arrivesAt: sentinel, [sentinel]: sentinel }] } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(sentinel);
    await app.close();
  });

  it('keeps a value of a personal-data property out of every answer while masking is asked, and shows it when it is not', async () => {
    const personal = linkedMappingOf({ entities: [{ type: 'maker', label: 'Maker', stable_id: 'makerId', filterable: ['region'], pii: [{ property: 'region', class: 'text' }] }, { type: 'tool', label: 'Tool', stable_id: 'toolId' }, { type: 'shop', label: 'Shop', stable_id: 'shopId' }] });
    const executor = new TestExecutor(() => {
      throw new Error('called the source');
    });
    const parts = testSourceGate(personal, { executor });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping: personal, gate: parts.gate, seams: communitySeams(), catalog: parts.catalog });
    const definition = { anchorType: 'maker', steps: [{ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', conditions: [{ op: 'eq', on: 'neighbor', property: 'region', value: { kind: 'text', value: 'SENTINEL-REGION' } }] }] };
    const masked = await preview(app, { sourceId: 'demo', definition, mask: true });
    expect(patternPreviewResponseSchema.parse(masked.json())).toEqual({ status: 'invalid', problems: [{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'personal-data-masked' }] });
    expect(masked.body).not.toContain('SENTINEL-REGION');
    const open = await preview(app, { sourceId: 'demo', definition });
    expect(patternPreviewResponseSchema.parse(open.json()).status).toBe('ok');
    expect(open.body).toContain('SENTINEL-REGION');
    expect(executor.calls).toEqual([]);
    await app.close();
  });
});
