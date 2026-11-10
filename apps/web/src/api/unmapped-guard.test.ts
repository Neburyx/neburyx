import { describe, expect, it } from 'vitest';
import { placeholderEdge, placeholderNode } from '../draft/unmapped.js';
import { createClientState } from '../state/client-state.js';
import { key } from '../state/test-data.js';
import { fakeClient } from './fake-client.js';
import { withoutUnmappedReads } from './unmapped-guard.js';

function held() {
  const state = createClientState();
  state.bindSource('s');
  const gone = placeholderNode('s', { t: 'gone', id: 'X' });
  const edge = placeholderEdge('s', { t: 'REL', from: { t: 'gone', id: 'X' }, to: { t: 'mapped', id: 'M' }, id: 'r1' });
  state.show({ id: 'i', sourceId: 's', record: { title: 'T', caseRef: null, status: 'open', readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key('s')], nodeRefs: [gone.ref], edgeRefs: [edge.ref] }, [{ key: key('s'), result: { sourceId: 's', nodes: [gone], edges: [edge] } }]);
  const sent: string[] = [];
  const spy = (name: string) => async () => {
    sent.push(name);
    return { ok: false as const, failure: { code: 'UNEXPECTED_FAILURE' as const } };
  };
  const client = withoutUnmappedReads(fakeClient({ getEntity: spy('getEntity'), getEdge: spy('getEdge'), previewExpansion: spy('previewExpansion'), expandNeighbors: spy('expandNeighbors'), derivedNeighbors: spy('derivedNeighbors') }), state);
  return { client, sent, edge };
}

describe('reads about items the mapping no longer covers', () => {
  it('answers each as not found and sends nothing', async () => {
    const { client, sent, edge } = held();
    const ref = { entityType: 'gone', stableId: 'X' };
    expect(await client.getEntity({ sourceId: 's', ...ref })).toMatchObject({ ok: false, failure: { code: 'NOT_FOUND' } });
    expect(await client.previewExpansion({ sourceId: 's', ref })).toMatchObject({ ok: false, failure: { code: 'NOT_FOUND' } });
    expect(await client.expandNeighbors({ sourceId: 's', ref, neighborTypes: ['x'] })).toMatchObject({ ok: false, failure: { code: 'NOT_FOUND' } });
    expect(await client.derivedNeighbors({ sourceId: 's', ref })).toMatchObject({ ok: false, failure: { code: 'NOT_FOUND' } });
    expect(await client.getEdge(edge.ref)).toMatchObject({ ok: false, failure: { code: 'NOT_FOUND' } });
    expect(sent).toEqual([]);
  });

  it('sends the reads about a mapped item', async () => {
    const { client, sent } = held();
    await client.getEntity({ sourceId: 's', entityType: 'mapped', stableId: 'M' });
    await client.previewExpansion({ sourceId: 's', ref: { entityType: 'mapped', stableId: 'M' } });
    expect(sent).toEqual(['getEntity', 'previewExpansion']);
  });
});
