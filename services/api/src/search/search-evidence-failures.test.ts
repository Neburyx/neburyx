import { searchResultSchema, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { createTemplateCatalog } from '../gate/catalog.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { schemaIndexesTemplate } from '../gate/templates/schema-indexes.js';
import { searchEvidenceTemplate } from '../gate/templates/search-evidence.js';
import { searchExactTemplate } from '../gate/templates/search-exact.js';
import { searchRelatedTemplate } from '../gate/templates/search-related.js';
import type { AuditEvent } from '../seams/seams.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { postSearch, RELATED_ENTITIES, searchMappingOf, startSearchApp, type SearchAppOptions } from '../testing/search-app.js';
import { searchModelOf, type StoredNode, type StoredRelationship } from '../testing/search-fixtures.js';

const TEXT = 'needle-9042';
const RELATIONSHIPS = [{ type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId'] }];
const mapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: RELATIONSHIPS });
const widgetNode: StoredNode = { elementId: '4:s:1', label: 'Widget', properties: { widgetId: TEXT } };
const gadgetNode: StoredNode = { elementId: '4:s:2', label: 'Gadget', properties: { gadgetId: 'GT-1', widgetRef: TEXT } };
const carrying: StoredRelationship = { elementId: '5:r:1', type: 'MADE_FROM', from: widgetNode, to: gadgetNode, properties: { linkId: 'L-1', recordId: TEXT } };
const model = searchModelOf([widgetNode, gadgetNode], () => undefined, [carrying]);

const failing =
  (templateId: string, outcome: ExecuteOutcome | Error) =>
  (call: ExecuteCall): Promise<ExecuteOutcome> =>
    call.templateId !== templateId ? model(call) : outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);

const failingAll = (outcomes: Readonly<Record<string, ExecuteOutcome | Error>>) => (call: ExecuteCall): Promise<ExecuteOutcome> => {
  const outcome = outcomes[call.templateId];
  return outcome === undefined ? model(call) : outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
};

async function searched(options: SearchAppOptions) {
  const parts = await startSearchApp({ mapping, respond: model, ...options });
  const response = await postSearch(parts.app, { sourceId: 'demo', text: TEXT });
  return { ...parts, response };
}

const answerOf = (json: unknown): SearchResult => searchResultSchema.parse(json);
const searchEvents = (events: readonly AuditEvent[]) => events.filter((event) => event.action.startsWith('entity.search')).map((event) => `${event.action} ${event.result}`).sort();
const TIMEOUT: ExecuteOutcome = { status: 'timeout' };
const DOWN: ExecuteOutcome = { status: 'unavailable', reason: 'unreachable' };

describe('an evidence read that fails while the other groups answer', () => {
  it('keeps the exact and the related group with their true counts, and names the evidence group with an unknown count and the budget of the timeout', async () => {
    const { response, events, lines } = await searched({ respond: failing('relationship-evidence', TIMEOUT) });
    expect(response.statusCode).toBe(200);
    const answer = answerOf(response.json());
    expect(answer.counts.exact).toEqual({ value: 1, quality: 'exact', scope: 'search:exact' });
    expect(answer.related.count).toEqual({ value: 1, quality: 'exact', scope: 'search:related' });
    expect(answer.evidence).toMatchObject({ hits: [], searchable: true, count: { quality: 'unknown', scope: 'search:evidence' } });
    expect(answer.evidence.count).not.toHaveProperty('value');
    expect(answer.failures).toEqual([{ group: 'evidence', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }]);
    expect(searchEvents(events)).toEqual(['entity.search success', 'entity.search_evidence failed', 'entity.search_related success']);
    expect(JSON.stringify([answer.failures, events])).not.toContain(TEXT);
    expect(lines.join('\n')).not.toContain(TEXT);
  });

  it('answers an unexpected error of the evidence read as a failure of that group only', async () => {
    const { response } = await searched({ respond: failing('relationship-evidence', new Error('the adapter broke')) });
    expect(answerOf(response.json()).failures).toEqual([{ group: 'evidence', code: 'INTERNAL_ERROR' }]);
  });

  it('answers a rate limit raised inside the evidence run as a failure of that group only, audited as failed', async () => {
    const limited = { ...searchEvidenceTemplate, normalize: (): never => { throw new AppError('RATE_LIMITED'); } };
    const catalog = createTemplateCatalog({ templates: [schemaIndexesTemplate, searchExactTemplate, searchRelatedTemplate, limited] });
    const { response, events } = await searched({ catalog });
    expect(answerOf(response.json()).failures).toEqual([{ group: 'evidence', code: 'RATE_LIMITED' }]);
    expect(events.filter((event) => event.action === 'entity.search_evidence')).toEqual([expect.objectContaining({ result: 'failed' })]);
  });

  it('answers a busy source for the one read it refuses as a failure of that group only', async () => {
    let reads = 0;
    const busyFourth = { acquireRead: () => Promise.resolve(++reads === 4 ? ({ status: 'busy' } as const) : ({ status: 'granted', lease: { release: () => Promise.resolve() } } as const)) };
    const { response } = await searched({ coordinator: busyFourth });
    const answer = answerOf(response.json());
    expect(answer.failures).toEqual([{ group: 'evidence', code: 'SOURCE_BUSY' }]);
    expect(answer.counts.exact.quality).toBe('exact');
  });

  it('adds nothing to the diagnostics for the failed run and keeps those of the pages that answered', async () => {
    const withLoss = (call: ExecuteCall): Promise<ExecuteOutcome> => {
      if (call.templateId === 'relationship-evidence') return Promise.resolve(TIMEOUT);
      if (call.templateId === 'entity-search') return Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: TEXT }, '4:e:1'), plainNode(['Nothing'], { x: 1 }, '4:e:2')));
      return model(call);
    };
    const { response } = await searched({ respond: withLoss });
    const answer = answerOf(response.json());
    expect(answer.dropped).toEqual({ 'not-mapped': 1, 'ambiguous-type': 0, 'no-stable-id': 0 });
    expect(answer.warnings).toHaveLength(1);
  });
});

describe('groups that fail together', () => {
  it('names the exact and the related group and keeps the evidence group when only those two fail', async () => {
    const { response } = await searched({ respond: failingAll({ 'entity-search': TIMEOUT, 'entity-related': new Error('broke') }) });
    const answer = answerOf(response.json());
    expect(answer.failures).toEqual([{ group: 'exact', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }, { group: 'related', code: 'INTERNAL_ERROR' }]);
    expect(answer.evidence.count).toEqual({ value: 1, quality: 'exact', scope: 'search:evidence' });
  });

  it('names the related and the evidence group and keeps the exact group when only those two fail', async () => {
    const { response } = await searched({ respond: failingAll({ 'entity-related': TIMEOUT, 'relationship-evidence': TIMEOUT }) });
    const answer = answerOf(response.json());
    expect(answer.failures.map((failure) => failure.group)).toEqual(['related', 'evidence']);
    expect(answer.counts.exact).toEqual({ value: 1, quality: 'exact', scope: 'search:exact' });
  });

  it('names the exact and the evidence group and keeps the related group when only those two fail, with the audit outcome of each run', async () => {
    const { response, events } = await searched({ respond: failingAll({ 'entity-search': TIMEOUT, 'relationship-evidence': new Error('broke') }) });
    const answer = answerOf(response.json());
    expect(answer.failures).toEqual([{ group: 'exact', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }, { group: 'evidence', code: 'INTERNAL_ERROR' }]);
    expect(answer.counts.exact).toEqual({ quality: 'unknown', scope: 'search:exact' });
    expect(answer.evidence.count).toEqual({ quality: 'unknown', scope: 'search:evidence' });
    expect(answer.related.count).toEqual({ value: 1, quality: 'exact', scope: 'search:related' });
    expect(searchEvents(events)).toEqual(['entity.search failed', 'entity.search_evidence failed', 'entity.search_related success']);
  });

  it('answers with the error of the exact group when every group that was read failed with a code of its own', async () => {
    const { response } = await searched({ respond: failingAll({ 'entity-search': TIMEOUT, 'entity-related': new Error('broke'), 'relationship-evidence': new Error('broke too') }) });
    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe('QUERY_TIMEOUT');
  });

  it('answers with the error of the evidence group when it is the only group that was read', async () => {
    const entities = [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }, { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' }];
    const only = searchMappingOf({ entities, relationships: RELATIONSHIPS });
    const { app } = await startSearchApp({ mapping: only, respond: failing('relationship-evidence', TIMEOUT) });
    const response = await postSearch(app, { sourceId: 'demo', text: TEXT });
    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe('QUERY_TIMEOUT');
    await app.close();
  });
});

describe('a failure that fails the whole search', () => {
  it.each([
    ['the evidence read', failing('relationship-evidence', DOWN)],
    ['the related read', failing('entity-related', DOWN)],
    ['the exact read', failing('entity-search', DOWN)],
    ['the evidence read, after the related read gave a failure of its own', failingAll({ 'entity-related': TIMEOUT, 'relationship-evidence': DOWN })],
    ['the evidence read, after the exact read gave a failure of its own', failingAll({ 'entity-search': TIMEOUT, 'relationship-evidence': DOWN })],
  ])('answers a source that is down, raised by %s, as the error of the search', async (_name, respond) => {
    const { response } = await searched({ respond });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: 'SOURCE_UNAVAILABLE', traceId: expect.any(String) });
    expect(response.json()).not.toHaveProperty('failures');
  });

  it('reads no other group when the exact read fails with an error that means the same for every group', async () => {
    const { response, executor } = await searched({ respond: failing('entity-search', DOWN) });
    expect(response.statusCode).toBe(503);
    expect(executor.calls.filter((call) => call.templateId !== 'schema-indexes').map((call) => call.templateId)).toEqual(['entity-search']);
  });
});

describe('the reads after the exact read settle before the answer', () => {
  it('waits for a slow evidence read when the related read has already failed, and leaves no read running', async () => {
    let release: (outcome: ExecuteOutcome) => void = () => undefined;
    const held = new Promise<ExecuteOutcome>((resolve) => {
      release = resolve;
    });
    let relatedAudited: () => void = () => undefined;
    const relatedDone = new Promise<void>((resolve) => {
      relatedAudited = resolve;
    });
    const recorded: AuditEvent[] = [];
    const audit = {
      record: (event: AuditEvent): Promise<void> => {
        recorded.push(event);
        if (event.action === 'entity.search_related' && event.result === 'failed') relatedAudited();
        return Promise.resolve();
      },
    };
    let heldCall: ExecuteCall | undefined;
    const respond = (call: ExecuteCall): Promise<ExecuteOutcome> => {
      if (call.templateId === 'entity-related') return Promise.resolve(TIMEOUT);
      if (call.templateId === 'relationship-evidence') {
        heldCall = call;
        return held;
      }
      return model(call);
    };
    const parts = await startSearchApp({ mapping, respond, audit });
    let answered = false;
    const pending = postSearch(parts.app, { sourceId: 'demo', text: TEXT }).then((response) => {
      answered = true;
      return response;
    });
    await relatedDone;
    await new Promise((resolve) => setImmediate(resolve));
    expect(answered).toBe(false);
    if (heldCall === undefined) throw new Error('the evidence read was not started');
    release(await model(heldCall));
    const answer = answerOf((await pending).json());
    expect(answered).toBe(true);
    expect(answer.failures).toEqual([{ group: 'related', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }]);
    expect(answer.evidence.hits.map((hit) => hit.supports.stableId)).toEqual(['L-1']);
    expect(parts.executor.calls.filter((call) => call.templateId !== 'schema-indexes')).toHaveLength(3);
    expect(searchEvents(recorded)).toEqual(['entity.search success', 'entity.search_evidence success', 'entity.search_related failed']);
    await parts.app.close();
  });
});
