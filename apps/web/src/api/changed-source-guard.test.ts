import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { fakeClient } from './fake-client.js';
import type { ApiClient } from './client.js';
import { withoutReadsWhileSourceChanged } from './changed-source-guard.js';

const READS = ['getEntity', 'getEdge', 'lookupEntity', 'readRefs', 'searchEntities', 'searchMore', 'previewExpansion', 'graphCoverage', 'expandNeighbors', 'derivedNeighbors', 'createExport'] as const;

function counting(): { readonly client: ApiClient; readonly sent: string[] } {
  const sent: string[] = [];
  const answers = Object.fromEntries(READS.map((name) => [name, async () => { sent.push(name); return { ok: true as const, value: {} as never }; }]));
  return { client: fakeClient(answers), sent };
}

function stateWith(sourceState?: 'available' | 'repointed' | 'removed') {
  const state = createClientState();
  if (sourceState !== undefined) state.show({ id: 'i-1', sourceId: 'source-a', record: { title: 'T', caseRef: null, status: 'open', readOnly: sourceState !== 'available', version: 1, save: { kind: 'unsaved' }, sourceState }, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
  return state;
}

const call = (client: ApiClient, name: (typeof READS)[number]) => (client[name] as (...args: unknown[]) => Promise<unknown>)({});

/** The calls of the client that do not read the source of the investigation on screen: the person, the registry of sources, the stored profile and the operator's source test, opening a new investigation (which names its own source), and the investigations and views in the application database. A call that is in neither list fails the test below, so a new reader is placed in one of them on purpose. */
const NOT_READS_OF_THE_SHOWN_INVESTIGATION = ['getMe', 'getSources', 'getProfile', 'listTemplates', 'testSource', 'openInvestigation', 'getInvestigation', 'saveDraft', 'deleteInvestigation', 'restoreInvestigation', 'deleteView', 'saveView', 'listViews', 'restoreView', 'renameView', 'changeInvestigationStatus', 'renameInvestigation', 'listInvestigations', 'listInvestigationPage', 'listOwnedViews', 'downloadExport'];

describe('the read guard of a changed source', () => {
  it('places every call of the client in the guarded reads or in the calls that do not read the source of the investigation on screen, so a new reader cannot be left unguarded', () => {
    const named = [...READS, ...NOT_READS_OF_THE_SHOWN_INVESTIGATION].sort();
    expect(Object.keys(fakeClient()).sort()).toEqual(named);
    expect(new Set(named).size).toBe(named.length);
  });

  it.each(['repointed', 'removed'] as const)('sends no read of any kind while the investigation shown has a source that is %s, and answers that the request ended', async (sourceState) => {
    const { client, sent } = counting();
    const guarded = withoutReadsWhileSourceChanged(client, stateWith(sourceState));
    for (const name of READS) expect(await call(guarded, name)).toEqual({ ok: false, failure: { code: 'ABORTED' } });
    expect(sent).toEqual([]);
  });

  it.each([undefined, 'available' as const])('passes every read through when the source is as it was (%s)', async (sourceState) => {
    const { client, sent } = counting();
    const guarded = withoutReadsWhileSourceChanged(client, stateWith(sourceState));
    for (const name of READS) await call(guarded, name);
    expect(sent).toEqual([...READS]);
  });

  it('follows the investigation on screen: reads go through again once another one is shown', async () => {
    const { client, sent } = counting();
    const state = stateWith('repointed');
    const guarded = withoutReadsWhileSourceChanged(client, state);
    await call(guarded, 'getEntity');
    state.describeInvestigation({ title: 'T', caseRef: null, status: 'open', readOnly: false, version: 1, save: { kind: 'unsaved' }, sourceState: 'available' });
    await call(guarded, 'getEntity');
    expect(sent).toEqual(['getEntity']);
  });

  it('leaves the calls that read no source alone', async () => {
    const calls: string[] = [];
    const client = fakeClient({ getInvestigation: async () => { calls.push('getInvestigation'); return { ok: false, failure: { code: 'NOT_FOUND', message: 'x', retryable: false, traceId: 't' } }; } });
    await withoutReadsWhileSourceChanged(client, stateWith('removed')).getInvestigation('id');
    expect(calls).toEqual(['getInvestigation']);
  });

  it('asks the method the client has at the time of the call, so a method replaced later is the one that is called', async () => {
    const { client } = counting();
    const state = stateWith('available');
    const guarded = withoutReadsWhileSourceChanged(client, state);
    const later: string[] = [];
    (client as { getEntity: unknown }).getEntity = async () => { later.push('replaced'); return { ok: true as const, value: {} as never }; };
    await guarded.getEntity({ sourceId: 's', entityType: 't', stableId: 'i' });
    expect(later).toEqual(['replaced']);
  });
});
