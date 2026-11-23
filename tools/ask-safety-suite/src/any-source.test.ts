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

async function assistantAnswer(synthetic: boolean | undefined, previewOn = true): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const rig = await startAssistantRig({ stub, ...(synthetic === undefined ? {} : { synthetic }), previewOn, maxSteps: 1, respond: (call) => (call.templateId === 'entity-load' ? { status: 'rows', rows: [{ n: { $type: 'node', elementId: '4:s:W-1', labels: ['Widget'], properties: { widgetId: 'W-1' } } }] } : undefined) });
  const answer = await rig.turn('Show W-1', [JSON.stringify({ route: 'ask', intent: 'widgetById', entities: { id: 'W-1' } }), '{"done":true}', JSON.stringify({ sentences: [{ text: 'Widget W-1 was read.', cites: ['r1'] }] })]);
  await rig.close();
  return { status: answer.status, body: withoutTokens(answer.body) };
}

/** The comparison of the test: every answer is the first, and the first is a turn that was answered. */
function expectTheSameAnswered(answers: readonly { readonly status: number; readonly body: Record<string, unknown> }[]): void {
  expect(answers[0]).toMatchObject({ status: 200, body: { status: 'answered', route: 'ask' } });
  for (const answer of answers) expect(answer).toEqual(answers[0]);
}

describe('the preview runs on any source, whatever the source says of being synthetic', () => {
  it('answers a question of Ask the same under each setting of the flag, answered and not refused', async () => {
    const answers = await Promise.all(FLAGS.map(([, flag]) => askAnswer(flag)));
    expect(JSON.stringify(answers[0])).not.toContain('refused');
    expect(JSON.stringify(answers[0])).toContain('W-001');
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it('answers a turn of the assistant the same under each setting of the flag, answered and not refused', async () => {
    const answers = [];
    for (const [, flag] of FLAGS) answers.push(await assistantAnswer(flag));
    expectTheSameAnswered(answers);
  });

  it('canary: a preview that is off for the source that sets synthetic to false answers differently, and the comparison of the test fails on it', async () => {
    const answers = await Promise.all([assistantAnswer(undefined), assistantAnswer(false, false), assistantAnswer(true)]);
    expect(answers[1]?.status).not.toBe(200);
    expect(() => expectTheSameAnswered(answers)).toThrow();
  });
});
