import { searchResultSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { gateRequest } from '../testing/gate.js';
import { postSearch, searchMappingOf, startSearchApp, type SearchAppOptions } from '../testing/search-app.js';

const TEXT = 'needle-text-9042';
const body = { sourceId: 'demo', text: TEXT };

const busy: Seams['coordinator'] = { acquireRead: () => Promise.resolve({ status: 'busy' }) };
const refusing: Seams['policy'] = { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'denied' }) };

const FAILURES: readonly (readonly [string, SearchAppOptions, number, string, string])[] = [
  ['a read that exceeds the source timeout', { respond: () => Promise.resolve({ status: 'timeout' }) }, 504, 'QUERY_TIMEOUT', 'failed'],
  ['a source that is busy', { coordinator: busy }, 503, 'SOURCE_BUSY', 'failed'],
  ['a source that is down', { respond: () => Promise.resolve({ status: 'unavailable', reason: 'unreachable' }) }, 503, 'SOURCE_UNAVAILABLE', 'failed'],
  ['a source that is not usable', { usability: { isUsable: () => false } }, 503, 'SOURCE_UNAVAILABLE', 'refused'],
  ['a principal the policy refuses', { policy: refusing }, 403, 'ACCESS_DENIED', 'denied'],
];

describe('a search that fails', () => {
  it.each(FAILURES)('answers %s with its code, no partial hit, and one audit event of the matching result', async (_name, options, status, code, result) => {
    const { app, events, store } = await startSearchApp(options);
    const response = await postSearch(app, body);
    expect(response.statusCode).toBe(status);
    expect(response.json().error).toMatchObject({ code, traceId: expect.any(String) });
    expect(response.json()).not.toHaveProperty('exact');
    expect(events.filter((event) => event.action === 'entity.search')).toEqual([expect.objectContaining({ result, sourceId: 'demo' })]);
    expect(store.investigations).toEqual([]);
    expect(store.drafts).toEqual([]);
    await app.close();
  });

  it('does not call the executor for a source that is not usable, for a principal the policy refuses or for a busy source', async () => {
    for (const options of [{ usability: { isUsable: () => false } }, { policy: refusing }, { coordinator: busy }]) {
      const { app, executor } = await startSearchApp(options);
      await postSearch(app, body);
      expect(executor.calls).toEqual([]);
      await app.close();
    }
  });

  it('tells the timeout of the source in the error of a read that timed out, and nothing else of it', async () => {
    const { app } = await startSearchApp({ mapping: searchMappingOf({ budgets: { timeout_ms: 3000 } }), respond: () => Promise.resolve({ status: 'timeout' }) });
    const response = await postSearch(app, body);
    expect(response.json().error.details).toEqual({ timeoutMs: 3000 });
    await app.close();
  });

  it('puts no typed text, query text or source address in any error body, log line or audit event', async () => {
    for (const [, options] of FAILURES) {
      const parts = await startSearchApp(options);
      const response = await postSearch(parts.app, body);
      const everything = [response.body, parts.lines.join('\n'), JSON.stringify(parts.events)].join('\n');
      expect(everything).not.toContain(TEXT);
      expect(everything).not.toContain('MATCH');
      expect(everything).not.toContain(parts.mapping.sources[0]?.uri ?? 'no uri');
      await parts.app.close();
    }
  });

  it('records a request the gate refuses as refused, and answers it as before when the audit write fails', async () => {
    const parts = await startSearchApp();
    const refused = gateRequest({ sourceId: 'demo', templateId: 'entity-search', limit: 25, params: { text: TEXT, targets: [{ entityType: 'widget', property: 'status' }] } });
    await expect(parts.gate.run(refused)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(parts.events).toEqual([expect.objectContaining({ action: 'entity.search', result: 'refused' })]);
    await parts.app.close();
    const failing: Seams['audit'] = { record: () => Promise.reject(new Error('the audit store is down')) };
    const still = await startSearchApp({ audit: failing });
    const response = await postSearch(still.app, { sourceId: 'demo', text: 'W-001' });
    expect(response.statusCode).toBe(200);
    expect(searchResultSchema.parse(response.json()).exact).toHaveLength(1);
    await still.app.close();
    expect(communitySeams().audit).toBeDefined();
  });
});
