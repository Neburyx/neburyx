import { ASSISTANT_EPOCH_HEADER } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { startAssistantRig } from './assistant-rig.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

const REFUSE = JSON.stringify({ route: 'refuse', cause: 'verdict' });
let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

describe('the count a turn reads, told to the client in a header', () => {
  it('is sent with the answer, rises with the person’s clearing, and is sent before the first line of a stream', async () => {
    const rig = await startAssistantRig({ stub, threads: true, respond: () => undefined });
    const first = await rig.turn('Is this fraud?', [REFUSE]);
    expect([first.status, first.headers[ASSISTANT_EPOCH_HEADER]]).toEqual([200, '0']);
    await rig.threadWritten(1);
    expect((await rig.clearChat()).status).toBe(200);
    const second = await rig.turn('Is this fraud?', [REFUSE]);
    expect(second.headers[ASSISTANT_EPOCH_HEADER]).toBe('1');
    const streamed = await rig.stream('Is this fraud?', [REFUSE]);
    expect([streamed.status, streamed.contentType]).toEqual([200, 'application/x-ndjson']);
    expect(streamed.headers[ASSISTANT_EPOCH_HEADER]).toBe('1');
    await rig.close();
  });

  it('is not sent when the turn is refused before it started', async () => {
    const rig = await startAssistantRig({ stub, threads: true, respond: () => undefined });
    const refused = await rig.post({ sourceId: 'demo', investigationId: rig.investigationId, message: '   ', viewElementKeys: [] });
    expect(refused.status).toBe(400);
    expect(refused.headers[ASSISTANT_EPOCH_HEADER]).toBeUndefined();
    await rig.close();
  });

  it('is not sent when the count cannot be read, and the answer is the same', async () => {
    const rig = await startAssistantRig({ stub, threads: false, respond: () => undefined });
    const answer = await rig.turn('Is this fraud?', [REFUSE]);
    expect(answer.status).toBe(200);
    expect(answer.headers[ASSISTANT_EPOCH_HEADER]).toBeUndefined();
    await rig.close();
  });
});
