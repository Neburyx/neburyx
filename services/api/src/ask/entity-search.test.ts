import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { describe, expect, it } from 'vitest';
import { RELATED_ENTITIES, searchCalls, relatedCalls, evidenceCalls, facetCalls, searchMappingOf } from '../testing/search-app.js';
import { searchModelOf, type StoredNode } from '../testing/search-fixtures.js';
import { startAskRig } from '../testing/ask-rig.js';
import { createAskEntitySearch } from './entity-search.js';

const SIGNAL = new AbortController().signal;
const mapping = searchMappingOf({ entities: RELATED_ENTITIES });
const stored: StoredNode[] = [
  { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1', ownerName: 'Ivo Lowe' } },
  { elementId: '4:s:2', label: 'Widget', properties: { widgetId: 'W-2', ownerName: 'Ana Silva' } },
];

describe('the exact search of the Ask resolution', () => {
  it('makes one exact read through the gate for the typed text, with the search\'s own bounded facet read, and no related or evidence read', async () => {
    const rig = await startAskRig({ mapping, respond: searchModelOf(stored) });
    const found = await createAskEntitySearch(rig.searching, rig.context())({ text: 'W-1' }, SIGNAL);
    expect(found.refs).toEqual([{ sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }]);
    expect(searchCalls(rig.executor)).toHaveLength(1);
    expect(searchCalls(rig.executor)[0]?.parameters['text']).toBe('W-1');
    expect([relatedCalls(rig.executor), evidenceCalls(rig.executor)]).toEqual([[], []]);
    expect(facetCalls(rig.executor)).toHaveLength(1);
    expect(rig.events.filter((event) => event.action === 'entity.search')).toHaveLength(1);
    await rig.app.close();
  });

  it('finds a typed name through a search property of the mapping, and never through a personal-data property while masking is on', async () => {
    const rig = await startAskRig({ mapping, respond: searchModelOf(stored) });
    const masked = await createAskEntitySearch(rig.searching, rig.context({ mask: true }))({ text: 'Ivo Lowe' }, SIGNAL);
    const unmasked = await createAskEntitySearch(rig.searching, rig.context({ mask: false }))({ text: 'Ivo Lowe' }, SIGNAL);
    expect(masked.refs).toEqual([]);
    expect(unmasked.refs).toEqual([{ sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }]);
    await rig.app.close();
  });

  it('finds nothing for an ID that only another source holds, and every read it makes names the source it was built for', async () => {
    const twoSources = parseMapping(
      fileOf(
        baseSource({ id: 'demo', entities: RELATED_ENTITIES, relationships: [] }),
        baseSource({ id: 'other', entities: RELATED_ENTITIES, relationships: [] }),
      ),
      'neburyx.yaml',
    );
    const model = searchModelOf([{ elementId: '4:o:1', label: 'Widget', properties: { widgetId: 'O-1' } }]);
    const rig = await startAskRig({ mapping: twoSources, respond: (call) => (call.sourceId === 'other' ? model(call) : Promise.resolve({ status: 'rows', rows: [] })) });
    const found = await createAskEntitySearch(rig.searching, rig.context())({ text: 'O-1' }, SIGNAL);
    expect([found.refs, found.unreferenced]).toEqual([[], 0]);
    expect(rig.executor.calls.length).toBeGreaterThan(0);
    expect(rig.executor.calls.every((call) => call.sourceId === 'demo')).toBe(true);
    await rig.app.close();
  });

  it('refuses a source the mapping does not hold, with no read', async () => {
    const rig = await startAskRig({ mapping, respond: searchModelOf(stored) });
    const before = rig.executor.calls.length;
    await expect(createAskEntitySearch(rig.searching, rig.context({ sourceId: 'absent' }))({ text: 'W-2' }, SIGNAL)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(rig.executor.calls).toHaveLength(before);
    await rig.app.close();
  });

  it.each([
    ['a read that exceeds the source timeout', () => Promise.resolve({ status: 'timeout' } as const), 'QUERY_TIMEOUT'],
  ])('fails with the code of the failure for %s, and returns no reference', async (_name, respond, code) => {
    const rig = await startAskRig({ mapping, respond });
    const failure = await createAskEntitySearch(rig.searching, rig.context())({ text: 'W-1' }, SIGNAL).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code });
    await rig.app.close();
  });

  it('counts a hit with no stable ID and does not return it as a reference', async () => {
    const withoutId: StoredNode[] = [...stored, { elementId: '4:s:3', label: 'Widget', properties: { ownerName: 'W-1' } }];
    const rig = await startAskRig({ mapping, respond: searchModelOf(withoutId) });
    const found = await createAskEntitySearch(rig.searching, rig.context({ mask: false }))({ text: 'W-1' }, SIGNAL);
    expect(found.refs.map((ref) => ref.stableId)).toEqual(['W-1']);
    expect(found.unreferenced).toBe(1);
    await rig.app.close();
  });

  it('returns the count of the group with its quality when there are more hits than the group shows', async () => {
    const many: StoredNode[] = Array.from({ length: 40 }, (_, index) => ({ elementId: `4:s:${index + 1}`, label: 'Widget', properties: { widgetId: `W-${index}`, ownerName: 'same' } }));
    const rig = await startAskRig({ mapping, respond: searchModelOf(many) });
    const found = await createAskEntitySearch(rig.searching, rig.context({ mask: false }))({ text: 'same' }, SIGNAL);
    expect(found.refs.length).toBeLessThanOrEqual(25);
    expect(found.count).toMatchObject({ quality: 'lowerBound' });
    await rig.app.close();
  });
});
