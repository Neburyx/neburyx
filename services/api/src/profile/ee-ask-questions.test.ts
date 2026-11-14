import { createEnterpriseExtension } from '@neburyx/ee-ask';
import type { AskClassification, AskClassifier } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { startSearchApp, widget } from '../testing/search-app.js';

afterAll(removeAskFolders);

const INTENTS = { widgetById: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: 'widget', stableId: '$id' } } } };
const post = (app: Awaited<ReturnType<typeof startSearchApp>>['app'], url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });

async function started(classification: AskClassification, options: { readonly previewOn?: boolean; readonly sourceIds?: readonly string[] } = {}) {
  const extension = createEnterpriseExtension();
  const folder = makeAskFolder(['demo'], INTENTS);
  const configured = await extension.configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: folder }, { sourceIds: options.sourceIds ?? ['demo'] });
  expect(configured?.ok).toBe(true);
  const events: AuditEvent[] = [];
  const asked: unknown[] = [];
  const classifier: AskClassifier = { availability: () => ({ available: true }), classify: async (input) => (asked.push(input), classification) };
  const seams = { ...communitySeams(), audit: { record: async (event: AuditEvent) => void events.push(event) }, askClassifier: classifier };
  const rig = await startSearchApp({ rows: [widget(1)], appOptions: { extension, previewOn: options.previewOn ?? true, seams } });
  return { ...rig, extension, events, asked };
}

describe('a question through the real mount of the enterprise extension', () => {
  it('runs once through the gate as the caller, and answers with the entity, one event and the intent', async () => {
    const { app, executor, events, asked } = await started({ ok: true, intent: 'widgetById', entities: { id: 'W-001' } });
    const answer = await post(app, '/v1/ask', { sourceId: 'demo', question: 'Show widget W-001' });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ answered: { intent: 'widgetById', entities: { id: 'W-001' }, outcome: 'complete', result: { templateId: 'entity' } } });
    expect(asked).toHaveLength(1);
    expect(executor.calls.filter((call) => call.templateId === 'entity-load')).toHaveLength(1);
    const questionEvents = events.filter((event) => event.action === 'ask.question');
    expect(questionEvents).toHaveLength(1);
    expect(JSON.stringify(questionEvents)).not.toMatch(/W-001|Show widget/);
    await app.close();
  });

  it('refuses a source the person may not read as not found, before the classifier is asked', async () => {
    const { app, asked } = await started({ ok: true, intent: 'widgetById', entities: { id: 'W-001' } });
    const answer = await post(app, '/v1/ask', { sourceId: 'nowhere', question: 'Show widget W-001' });
    expect(answer.statusCode).toBe(404);
    expect(asked).toEqual([]);
    await app.close();
  });

  it('answers a refusal of the classifier as a 200 with the cause, and the Community cause as the unsupported refusal', async () => {
    const refused = await started({ ok: false, cause: 'no-intent' });
    expect((await post(refused.app, '/v1/ask', { sourceId: 'demo', question: 'What is the weather?' })).json()).toMatchObject({ refused: { cause: 'no-intent' } });
    await refused.app.close();
    const unavailable = await started({ ok: false, cause: 'unavailable' });
    const answer = await post(unavailable.app, '/v1/ask', { sourceId: 'demo', question: 'anything' });
    expect([answer.statusCode, answer.json().error.code, answer.json().error.details]).toEqual([422, 'ASK_UNSUPPORTED', { reason: 'not-in-this-edition' }]);
    await unavailable.app.close();
  });

  it('answers a body that is not valid as an invalid request, and an unknown field too', async () => {
    const { app } = await started({ ok: false, cause: 'no-intent' });
    for (const payload of [{ sourceId: 'demo', question: '' }, { sourceId: 'demo', question: 'q', extra: 1 }, { question: 'q' }]) expect((await post(app, '/v1/ask', payload)).statusCode, JSON.stringify(payload)).toBe(400);
    await app.close();
  });

  it('refuses the continue of a token that was not issued, with the reason continue-invalid', async () => {
    const { app } = await started({ ok: false, cause: 'no-intent' });
    const answer = await post(app, '/v1/ask/continue', { sourceId: 'demo', intent: 'widgetById', entities: { id: 'W-001' }, continueToken: `${Date.now() + 1000}.${'a'.repeat(64)}` });
    expect([answer.statusCode, answer.json().error.code, answer.json().error.details]).toEqual([400, 'INVALID_REQUEST', { reason: 'continue-invalid' }]);
    await app.close();
  });

  it('refuses both routes with the preview off, as the other routes of the group', async () => {
    const { app } = await started({ ok: false, cause: 'no-intent' }, { previewOn: false });
    for (const url of ['/v1/ask', '/v1/ask/continue']) {
      const answer = await post(app, url, { sourceId: 'demo', question: 'q', intent: 'x', entities: {}, continueToken: `1.${'a'.repeat(64)}` });
      expect([answer.statusCode, answer.json().error.code]).toEqual([403, 'ACCESS_DENIED']);
    }
    await app.close();
  });
});
