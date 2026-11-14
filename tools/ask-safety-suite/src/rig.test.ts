import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { widget } from '../../../services/api/src/testing/search-app.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import { folderOf, reply } from './fixtures.js';
import { recordingRunStore, startRig, type Rig } from './rig.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

async function rigOf(): Promise<Rig> {
  const store = recordingRunStore();
  const extension = createEnterpriseExtension({ modelBaseUrl: stub.baseUrl, runStore: store.factory });
  return startRig({ extension, stub, rows: store.rows, folder: folderOf(), respond: () => Promise.resolve(entityRows(widget(1))) });
}

describe('the rig of the suite', () => {
  it('asks a question through the real classifier and provider, runs the intent once at the source and keeps every record', async () => {
    const rig = await rigOf();
    const answer = await rig.ask('Show widget W-001', reply('widgetById', { id: 'W-001' }));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ answered: { intent: 'widgetById' } });
    expect(stub.requests).toHaveLength(1);
    expect(rig.reads().length).toBeGreaterThan(0);
    expect(rig.appEvents.some((event) => event.action === 'ask.question')).toBe(true);
    expect(rig.modelEvents.length).toBeGreaterThan(0);
    expect(rig.rows).toHaveLength(1);
    await rig.close();
  });

  it('counts what a case expects: a refusal before any run leaves no read and one model call', async () => {
    const rig = await rigOf();
    expect((await rig.ask('anything', reply(null))).body).toMatchObject({ refused: { cause: 'no-intent' } });
    expect(stub.requests).toHaveLength(1);
    expect(rig.reads()).toEqual([]);
    await rig.close();
  });
});
