import { describe, expect, it } from 'vitest';
import { answering, startSearchApp, widget } from '../testing/search-app.js';
import { rangeIndex, schemaAnswer, withSchema } from '../testing/search-fixtures.js';

const get = (app: Awaited<ReturnType<typeof startSearchApp>>['app']) => app.inject({ method: 'GET', url: '/v1/entities/demo/widget/W-001' });

describe('the entity read and the index of its type', () => {
  it('answers 503 SOURCE_UNAVAILABLE, not retryable, with the reason index-unavailable, when the stable-ID index has been dropped since the check, and no statement names the type', async () => {
    const { app, executor, events } = await startSearchApp({ ownSchema: true, respond: withSchema(() => schemaAnswer([]), answering([widget(1)])) });
    const response = await get(app);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: 'SOURCE_UNAVAILABLE', retryable: false, details: { reason: 'index-unavailable' } });
    expect(executor.calls.map((call) => call.templateId)).toEqual(['schema-indexes']);
    expect(events.filter((event) => event.action === 'entity.load')).toEqual([expect.objectContaining({ result: 'refused' })]);
    await app.close();
  });

  it('answers the node, with one schema read and one data read, when the index is online', async () => {
    const { app, executor } = await startSearchApp({ ownSchema: true, respond: withSchema(() => schemaAnswer([rangeIndex('Widget', 'widgetId', 'ONLINE', true)]), answering([widget(1)])) });
    const response = await get(app);
    expect(response.statusCode).toBe(200);
    expect(executor.calls.map((call) => call.templateId)).toEqual(['schema-indexes', 'entity-load']);
    await app.close();
  });

  it('refuses a stable-ID index that is still being built, as a missing one', async () => {
    const { app } = await startSearchApp({ ownSchema: true, respond: withSchema(() => schemaAnswer([rangeIndex('Widget', 'widgetId', 'POPULATING')]), answering([widget(1)])) });
    expect((await get(app)).statusCode).toBe(503);
    await app.close();
  });
});
