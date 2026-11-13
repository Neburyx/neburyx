import { rmSync } from 'node:fs';
import { MAX_PATTERN_PROBLEMS, patternValidateResponseSchema } from '@neburyx/contracts';
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

/** An executor that fails the test on any call: the route answers from the mapping alone. */
async function started(options: { readonly deny?: boolean } = {}) {
  const executor = new TestExecutor(() => {
    throw new Error('the validate route called the source');
  });
  const defaults = communitySeams();
  const seams = { ...defaults, policy: options.deny === true ? { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } : defaults.policy };
  const parts = testSourceGate(mapping, { executor });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams, catalog: parts.catalog });
  return { app, executor };
}

type Started = Awaited<ReturnType<typeof started>>;
const send = (app: Started['app'], body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => app.inject({ method: 'POST', url: '/v1/patterns/validate', payload: typeof body === 'string' ? body : JSON.stringify(body), headers });
const codeOf = (response: { json(): unknown }): unknown => (response.json() as { error?: { code?: unknown } }).error?.code;

const ok = { anchorType: 'maker', steps: [{ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker' }] };

describe('POST /v1/patterns/validate', () => {
  it('answers ok for a pattern the mapping allows, and reads nothing from the source', async () => {
    const { app, executor } = await started();
    const response = await send(app, { sourceId: 'demo', definition: ok });
    expect(response.statusCode).toBe(200);
    expect(patternValidateResponseSchema.parse(response.json())).toEqual({ status: 'ok' });
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('answers invalid with the problems of the mapping, each with its path and code, when the definition is well formed', async () => {
    const { app } = await started();
    const response = await send(app, { sourceId: 'demo', definition: { anchorType: 'maker', steps: [{ relationshipTypes: ['LINKS', 'NOPE'], direction: 'out', arrivesAt: 'tool' }] } });
    expect(response.statusCode).toBe(200);
    expect(patternValidateResponseSchema.parse(response.json())).toEqual({
      status: 'invalid',
      problems: [
        { path: ['steps', 0, 'relationshipTypes', 0], code: 'relationship-does-not-join' },
        { path: ['steps', 0, 'relationshipTypes', 1], code: 'unknown-relationship-type' },
      ],
    });
    await app.close();
  });

  it('answers the problems of the shape alone when the schema fails, and more than four steps is too-many at steps whatever the source allows', async () => {
    const { app } = await started();
    const five = Array.from({ length: 5 }, () => ({ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker' }));
    expect(patternValidateResponseSchema.parse((await send(app, { sourceId: 'demo', definition: { anchorType: 'nothing', steps: five } })).json())).toEqual({ status: 'invalid', problems: [{ path: ['steps'], code: 'too-many' }] });
    expect(patternValidateResponseSchema.parse((await send(app, { sourceId: 'demo', definition: { anchorType: 'maker', steps: [{ ...ok.steps[0], extra: 1 }] } })).json())).toEqual({ status: 'invalid', problems: [{ path: ['steps', 0], code: 'unknown-key' }] });
    expect(patternValidateResponseSchema.parse((await send(app, { sourceId: 'demo', definition: {} })).json())).toMatchObject({ status: 'invalid' });
    await app.close();
  });

  it('lists at most the cap of problems however many faults the definition has, and the list parses with the shared schema', async () => {
    const { app } = await started();
    const faulty = { relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', conditions: Array.from({ length: 12 }, () => ({ op: 'eq' })) };
    const response = await send(app, { sourceId: 'demo', definition: { anchorType: 'maker', steps: Array.from({ length: 4 }, () => faulty) } });
    const answer = patternValidateResponseSchema.parse(response.json());
    expect(answer.status === 'invalid' && answer.problems.length).toBe(MAX_PATTERN_PROBLEMS);
    await app.close();
  });

  it('makes a condition on personal data a problem only while masking is asked', async () => {
    const personal = linkedMappingOf({ entities: [{ type: 'maker', label: 'Maker', stable_id: 'makerId', filterable: ['region'], pii: [{ property: 'region', class: 'text' }] }, { type: 'tool', label: 'Tool', stable_id: 'toolId' }, { type: 'shop', label: 'Shop', stable_id: 'shopId' }] });
    const executor = new TestExecutor(() => {
      throw new Error('called the source');
    });
    const parts = testSourceGate(personal, { executor });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping: personal, gate: parts.gate, seams: communitySeams(), catalog: parts.catalog });
    const definition = { anchorType: 'maker', steps: [{ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', conditions: [{ op: 'eq', on: 'neighbor', property: 'region', value: { kind: 'text', value: 'a' } }] }] };
    expect(patternValidateResponseSchema.parse((await send(app, { sourceId: 'demo', definition })).json())).toEqual({ status: 'ok' });
    expect(patternValidateResponseSchema.parse((await send(app, { sourceId: 'demo', definition, mask: true })).json())).toEqual({ status: 'invalid', problems: [{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'personal-data-masked' }] });
    await app.close();
  });

  it('refuses a body that is not the envelope: INVALID_REQUEST for the wrong shape, a definition that is not an object, malformed JSON or a body over 1 MiB, UNSUPPORTED_MEDIA_TYPE for a body that is not JSON', async () => {
    const { app, executor } = await started();
    const sentinel = 'SENTINEL-BODY';
    for (const body of [{ definition: ok }, { sourceId: 'demo' }, { sourceId: 'demo', definition: [] }, { sourceId: 'demo', definition: 'x' }, { sourceId: 'demo', definition: ok, mask: 'yes' }, { sourceId: 'demo', definition: ok, [sentinel]: 1 }, { sourceId: '', definition: ok }]) {
      const response = await send(app, body);
      expect(codeOf(response), JSON.stringify(body)).toBe('INVALID_REQUEST');
      expect(response.body).not.toContain(sentinel);
    }
    expect(codeOf(await send(app, `{"sourceId": "demo", "definition": ${sentinel}`))).toBe('INVALID_REQUEST');
    expect(codeOf(await send(app, { sourceId: 'demo', definition: { anchorType: 'x'.repeat(1_100_000), steps: [] } }))).toBe('INVALID_REQUEST');
    expect(codeOf(await send(app, JSON.stringify({ sourceId: 'demo', definition: ok }), { 'content-type': 'text/plain' }))).toBe('INVALID_REQUEST');
    expect(codeOf(await send(app, JSON.stringify({ sourceId: 'demo', definition: ok }), { 'content-type': 'application/xml' }))).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect((await app.inject({ method: 'POST', url: '/v1/patterns/validate?x=1', payload: JSON.stringify({ sourceId: 'demo', definition: ok }), headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('answers NOT_FOUND for a source that is not configured and for one the person may not read, the same answer, and no value of the request is in an answer', async () => {
    const { app } = await started();
    const unknown = await send(app, { sourceId: 'SENTINEL-SOURCE', definition: ok });
    expect(codeOf(unknown)).toBe('NOT_FOUND');
    expect(unknown.body).not.toContain('SENTINEL-SOURCE');
    const denied = await started({ deny: true });
    const refused = await send(denied.app, { sourceId: 'demo', definition: ok });
    expect(codeOf(refused)).toBe('NOT_FOUND');
    expect(denied.executor.calls).toEqual([]);
    await app.close();
    await denied.app.close();
  });

  it('puts no value of the definition in any answer', async () => {
    const { app } = await started();
    const sentinel = 'SENTINEL-DEFINITION';
    const response = await send(app, { sourceId: 'demo', definition: { anchorType: sentinel, steps: [{ relationshipTypes: [sentinel], direction: sentinel, arrivesAt: sentinel, [sentinel]: sentinel, conditions: [{ op: 'eq', on: 'neighbor', property: sentinel, value: { kind: 'text', value: sentinel } }] }] } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(sentinel);
    await app.close();
  });
});
