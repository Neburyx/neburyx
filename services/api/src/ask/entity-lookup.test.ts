import { describe, expect, it } from 'vitest';
import { entityCalls, entityRows, plainNode } from '../testing/entity-fixtures.js';
import { searchMappingOf } from '../testing/search-app.js';
import { startAskRig } from '../testing/ask-rig.js';
import { createAskEntityLookup } from './entity-lookup.js';

const SIGNAL = new AbortController().signal;
const mapping = searchMappingOf();
const respond = (call: { readonly parameters: Readonly<Record<string, unknown>> }) =>
  Promise.resolve(call.parameters['stableId'] === 'W-1' ? entityRows(plainNode(['Widget'], { widgetId: 'W-1' }, '4:s:1')) : entityRows());
const ref = (stableId: string, sourceId = 'demo') => ({ sourceId, entityType: 'widget', stableId });

describe('the lookup of the Ask resolution', () => {
  it('answers true for an entity that exists and false for one that does not, by the gated entity read', async () => {
    const rig = await startAskRig({ mapping, respond });
    const lookup = createAskEntityLookup(rig.reader, rig.context());
    expect(await lookup(ref('W-1'), SIGNAL)).toBe(true);
    expect(await lookup(ref('W-9'), SIGNAL)).toBe(false);
    expect(entityCalls(rig.executor.calls)).toHaveLength(2);
    await rig.app.close();
  });

  it('answers false for a reference of another source, without a read', async () => {
    const rig = await startAskRig({ mapping, respond });
    const before = rig.executor.calls.length;
    expect(await createAskEntityLookup(rig.reader, rig.context())(ref('W-1', 'src-b'), SIGNAL)).toBe(false);
    expect(rig.executor.calls).toHaveLength(before);
    await rig.app.close();
  });

  it('fails for a failure that is not a missing entity', async () => {
    const rig = await startAskRig({ mapping, respond: () => Promise.resolve({ status: 'timeout' }) });
    await expect(createAskEntityLookup(rig.reader, rig.context())(ref('W-1'), SIGNAL)).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    await rig.app.close();
  });

  it('counts the read against the request limiter, as a search does', async () => {
    const rig = await startAskRig({ mapping, respond });
    let counted = 0;
    const original = rig.reader.read.bind(rig.reader);
    const spy = { read: (request: Parameters<typeof original>[0]) => (request.rate === 'count' ? counted++ : undefined, original(request)) };
    await createAskEntityLookup(spy, rig.context())(ref('W-1'), SIGNAL);
    expect(counted).toBe(1);
    await rig.app.close();
  });
});
