import { createEnterpriseExtension } from '@neburyx/ee-ask';
import type { AskClassification, AskClassifier, AskRunner, ElementRefs, SummaryReading } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { currentReadOrigin } from '../seams/read-origin.js';
import type { Coordinator, ReadAccessRequest } from '../seams/seams.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { postSearch, startSearchApp, widget } from '../testing/search-app.js';
import { markAskRunner, markReadElements } from './ai-reads.js';

afterAll(removeAskFolders);

const INTENTS = { widgetById: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: 'widget', stableId: '$id' } } } };
const CLASSIFICATION: AskClassification = { ok: true, intent: 'widgetById', entities: { id: 'W-001' } };

async function started() {
  const extension = createEnterpriseExtension();
  const configured = await extension.configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder(['demo'], INTENTS) }, { sourceIds: ['demo'] });
  expect(configured?.ok).toBe(true);
  const requests: ReadAccessRequest[] = [];
  const defaults = communitySeams();
  const coordinator: Coordinator = { acquireRead: (request) => (requests.push(request), defaults.coordinator.acquireRead(request)) };
  const classifier: AskClassifier = { availability: () => ({ available: true }), classify: async () => CLASSIFICATION };
  const rig = await startSearchApp({ rows: [widget(1)], coordinator, appOptions: { extension, previewOn: true, seams: { ...defaults, coordinator, askClassifier: classifier } } });
  return { ...rig, requests };
}

describe('the origin of the reads of an application with the enterprise extension', () => {
  it('marks every read of an Ask question as an AI read', async () => {
    const { app, requests } = await started();
    const answer = await app.inject({ method: 'POST', url: '/v1/ask', payload: JSON.stringify({ sourceId: 'demo', question: 'Show widget W-001' }), headers: { 'content-type': 'application/json' } });
    expect(answer.statusCode).toBe(200);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.map((request) => request.origin)).toEqual(requests.map(() => 'ai'));
    await app.close();
  });

  it('marks no read of a manual route', async () => {
    const { app, requests } = await started();
    const answer = await postSearch(app, { sourceId: 'demo', text: 'widget' });
    expect(answer.statusCode).toBe(200);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.map((request) => request.origin ?? 'manual')).toEqual(requests.map(() => 'manual'));
    await app.close();
  });
});

describe('the capabilities that mark AI reads', () => {
  it('runs an Ask runner and an element read as AI reads, and leaves the code around them manual', async () => {
    const seen: string[] = [];
    const runner = markAskRunner(() => ({ run: async () => (seen.push(currentReadOrigin()), { status: 'refused', refusal: { code: 'NOT_FOUND' } }) } satisfies AskRunner));
    await runner({ sourceId: 'demo', mask: false }).run({ templateId: 'entity', params: {} });
    const read = markReadElements(async () => (seen.push(currentReadOrigin()), { missing: 0 } as unknown as SummaryReading));
    await read({ investigationId: 'i', sourceId: 'demo', mask: false }, { entities: [], edges: [], aggregates: [], derived: [] } satisfies ElementRefs);
    expect(seen).toEqual(['ai', 'ai']);
    expect(currentReadOrigin()).toBe('manual');
  });
});
