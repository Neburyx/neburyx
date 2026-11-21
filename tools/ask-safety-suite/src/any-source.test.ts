import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import { searchMappingOf, widget } from '../../../services/api/src/testing/search-app.js';
import { startAssistantRig } from './assistant-rig.js';
import { folderOf, reply } from './fixtures.js';
import { recordingRunStore, startRig } from './rig.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

/** The same source with no `synthetic` flag, with it false and with it true: the preview must give the same answer under each. */
const FLAGS = [['no flag', undefined], ['synthetic: false', false], ['synthetic: true', true]] as const;

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

async function askAnswer(synthetic: boolean | undefined): Promise<Record<string, unknown>> {
  const store = recordingRunStore();
  const extension = createEnterpriseExtension({ modelBaseUrl: stub.baseUrl, runStore: store.factory });
  const rig = await startRig({ extension, stub, rows: store.rows, folder: folderOf(), mapping: searchMappingOf(synthetic === undefined ? {} : { synthetic }), respond: () => Promise.resolve(entityRows(widget(1))) });
  const answer = await rig.ask('Show it', reply('widgetById', { id: 'W-001' }));
  await rig.close();
  return answer.body as Record<string, unknown>;
}

/** An answer with the tokens of its choices made alike: each carries the time it was made, so two answers to one question differ in them and in nothing else. */
const withoutTokens = (answer: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(answer, (key, value: unknown) => (key === 'choiceToken' || key === 'continueToken' ? 'token' : value))) as Record<string, unknown>;

async function assistantAnswer(synthetic: boolean | undefined): Promise<Record<string, unknown>> {
  const rig = await startAssistantRig({ stub, ...(synthetic === undefined ? {} : { synthetic }), maxSteps: 1, respond: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: { $type: 'node', elementId: '4:s:W-1', labels: ['Widget'], properties: { widgetId: 'W-1' } } }] } : undefined) });
  const answer = await rig.turn('Show W-1', [JSON.stringify({ route: 'ask', intent: 'widgetById', entities: { id: 'W-1' } })]);
  await rig.close();
  expect(answer.status).toBe(200);
  return withoutTokens(answer.body);
}

describe('the preview runs on any source, whatever the source says of being synthetic', () => {
  it('answers a question of Ask the same under each setting of the flag, answered and not refused', async () => {
    const answers = await Promise.all(FLAGS.map(([, flag]) => askAnswer(flag)));
    expect(JSON.stringify(answers[0])).not.toContain('refused');
    expect(JSON.stringify(answers[0])).toContain('W-001');
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it('answers a turn of the assistant the same under each setting of the flag, answered and not refused', async () => {
    const answers = await Promise.all(FLAGS.map(([, flag]) => assistantAnswer(flag)));
    expect(answers[0]).toMatchObject({ status: 'answered', route: 'ask' });
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it('canary: a source that gave the flag a meaning would answer differently, so the comparison can fail', async () => {
    const answered = await assistantAnswer(undefined);
    expect(() => expect({ ...answered, status: 'refused' }).toEqual(answered)).toThrow();
  });
});
