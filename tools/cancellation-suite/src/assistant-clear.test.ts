import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../../apps/web/src/api/client.js';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { startAssistantApp, type AssistantApp } from '../../../services/api/src/testing/assistant-turns.js';
import { startModelStub, type ModelStub } from '../../ask-safety-suite/src/stub.js';

const REFUSE = JSON.stringify({ route: 'refuse', cause: 'verdict' });

let model: ModelStub;
let app: AssistantApp;

beforeEach(async () => {
  model = await startModelStub();
  app = await startAssistantApp({ model, threads: true });
});
afterEach(async () => {
  await app.close();
  await model.close();
  removeAskFolders();
});

async function realClient() {
  const base = await app.baseUrl();
  return createApiClient((input, init) => fetch(`${base}${input}`, init));
}
const request = (message: string) => ({ sourceId: 'demo', investigationId: app.investigationId, message, viewElementKeys: [] });

describe('the clearing of a chat, from the real web client to the real application', () => {
  it('clears the thread the client read, tells the count through the header on the stream and on the JSON answer, and a fresh read finds the thread empty with a higher count', async () => {
    const client = await realClient();
    const counts: number[] = [];
    model.replies.push(REFUSE, REFUSE);
    const streamed = await client.assistantTurn(request('Is this fraud?'), undefined, () => undefined, (epoch) => counts.push(epoch));
    expect(streamed.ok).toBe(true);
    const plain = await client.assistantTurn(request('Is this fraud again?'), undefined, undefined, (epoch) => counts.push(epoch));
    expect(plain.ok).toBe(true);
    expect(counts).toEqual([0, 0]);
    await app.threadWritten(2);
    const before = await client.assistantThread(app.investigationId, false);
    expect(before).toMatchObject({ ok: true, value: { epoch: 0 } });
    expect(before.ok && before.value.turns).toHaveLength(2);
    expect(await client.clearAssistantThread(app.investigationId)).toEqual({ ok: true, value: { cleared: true } });
    const after = await client.assistantThread(app.investigationId, false);
    expect(after).toMatchObject({ ok: true, value: { epoch: 1, turns: [], previousThreadClearedAt: null } });
    expect(app.threadText()).toBe('[]');
    expect(await client.clearAssistantThread(app.investigationId)).toEqual({ ok: true, value: { cleared: false } });
    model.replies.push(REFUSE);
    await client.assistantTurn(request('Is this fraud?'), undefined, undefined, (epoch) => counts.push(epoch));
    expect(counts).toEqual([0, 0, 2]);
  });

  it('refuses a body that is not the empty object, and an investigation that is not the caller’s, with the application’s own errors, and deletes nothing', async () => {
    const client = await realClient();
    model.replies.push(REFUSE);
    await client.assistantTurn(request('Is this fraud?'), undefined, undefined, undefined);
    await app.threadWritten(1);
    const base = await app.baseUrl();
    const post = (id: string, body: string | undefined) => fetch(`${base}/v1/assistant/investigations/${id}/thread/clear`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }) });
    for (const body of ['{"cleared":true}', '[]', '"x"', undefined]) expect((await post(app.investigationId, body)).status).toBe(400);
    expect((await post('0192f000-0000-7000-8000-00000000ffff', '{}')).status).toBe(404);
    expect(await client.assistantThread(app.investigationId, false)).toMatchObject({ ok: true, value: { turns: [expect.anything()] } });
  });
});
