import { rmSync } from 'node:fs';
import { aiStatusResponseSchema, type AiStatusResponse, type ProfileExtension } from '@neburyx/contracts';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, registeredRoutesOf } from '../app.js';
import { memoryAppStore } from '../testing/app-store.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const NONE = { ask: { available: false }, summary: { available: false }, assistant: { available: false } };
const extensionSaying = (availability: () => AiStatusResponse): ProfileExtension => ({ name: 'probe', routeGroups: [], aiAvailability: availability });

async function started(extension?: ProfileExtension) {
  return buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), ...(extension === undefined ? {} : { extension, previewOn: true }) });
}

describe('GET /v1/ai/status', () => {
  it('answers that no feature is available when no extension is loaded, declares the principal permission and answers the declared schema', async () => {
    const app = await started();
    const answer = await app.inject({ url: '/v1/ai/status' });
    expect([answer.statusCode, answer.json()]).toEqual([200, NONE]);
    expect(aiStatusResponseSchema.safeParse(answer.json()).success).toBe(true);
    expect(registeredRoutesOf(app).find((route) => route.url === '/v1/ai/status')).toMatchObject({ method: 'GET', permission: 'principal' });
    await app.close();
  });

  it('answers the availability the extension reports, and none when the extension says nothing of it', async () => {
    const reporting = await started(extensionSaying(() => ({ ask: { available: true }, summary: { available: false }, assistant: { available: false } })));
    expect((await reporting.inject({ url: '/v1/ai/status' })).json()).toEqual({ ask: { available: true }, summary: { available: false }, assistant: { available: false } });
    await reporting.close();
    const silent = await started({ name: 'probe', routeGroups: [] });
    expect((await silent.inject({ url: '/v1/ai/status' })).json()).toEqual(NONE);
    await silent.close();
  });

  it('answers the model of an available assistant, and refuses an available one without it', async () => {
    const available = { ask: { available: false }, summary: { available: false }, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } };
    const reporting = await started(extensionSaying(() => available));
    const answer = await reporting.inject({ url: '/v1/ai/status' });
    expect([answer.statusCode, answer.json()]).toEqual([200, available]);
    await reporting.close();
    // @ts-expect-error an available assistant without its model is not of the declared shape
    const missing = await started(extensionSaying(() => ({ ...available, assistant: { available: true, messageWords: 1000 } })));
    expect((await missing.inject({ url: '/v1/ai/status' })).statusCode).toBe(500);
    await missing.close();
  });

  it('does not pass on an answer of the extension that is not of the declared shape', async () => {
    // @ts-expect-error the answer of an extension that is not of the declared shape
    const app = await started(extensionSaying(() => ({ preview: true })));
    const answer = await app.inject({ url: '/v1/ai/status' });
    expect([answer.statusCode, answer.json().error.code]).toEqual([500, 'INTERNAL_ERROR']);
    await app.close();
  });
});
