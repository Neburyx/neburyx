import { act, configure, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { testProfile } from '../dev/test-profile.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, listItemOf, nodeOf, listOf } from '../investigations/test-data.js';
import { createClientState } from '../state/client-state.js';
import { renderApp } from '../test-utils.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const C_ID = '0192f000-0000-7000-8000-0000000000c1';
const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };
const OLDER = { investigation: investigationOf('0192f000-0000-7000-8000-0000000000d1', 'source-a', 'kind-a', 'OLD-1'), node: nodeOf('source-a', 'kind-a', 'OLD-1') };
const NEWER = { investigation: investigationOf(C_ID, 'source-a', 'kind-a', 'N-1'), node: nodeOf('source-a', 'kind-a', 'N-1') };

function recording(client: ApiClient) {
  const calls: string[] = [];
  const wrapped: ApiClient = {
    getMe: (signal) => (calls.push('getMe'), client.getMe(signal)),
    getSources: (signal) => (calls.push('getSources'), client.getSources(signal)),
    getProfile: (sourceId, signal) => (calls.push(`getProfile ${sourceId}`), client.getProfile(sourceId, signal)),
    testSource: (sourceId, signal) => (calls.push('testSource'), client.testSource(sourceId, signal)),
    getEntity: (ref, options, signal) => (calls.push('getEntity'), client.getEntity(ref, options, signal)),
    getEdge: (ref, options, signal) => (calls.push('getEdge'), client.getEdge(ref, options, signal)),
    openInvestigation: (request, signal) => (calls.push('openInvestigation'), client.openInvestigation(request, signal)),
    getInvestigation: (id, signal) => (calls.push('getInvestigation'), client.getInvestigation(id, signal)),
    listInvestigations: (limit, signal) => (calls.push('listInvestigations'), client.listInvestigations(limit, signal)),
    saveDraft: (id, version, draft, options) => (calls.push('saveDraft'), client.saveDraft(id, version, draft, options)),
    readRefs: (request, signal) => (calls.push('readRefs'), client.readRefs(request, signal)),
    searchEntities: (request, signal) => (calls.push('searchEntities'), client.searchEntities(request, signal)),
    searchMore: (request, signal) => (calls.push('searchMore'), client.searchMore(request, signal)),
    lookupEntity: (request, signal) => (calls.push('lookupEntity'), client.lookupEntity(request, signal)),
    previewExpansion: (request, signal) => (calls.push('previewExpansion'), client.previewExpansion(request, signal)),
    expandNeighbors: (request, signal) => (calls.push('expandNeighbors'), client.expandNeighbors(request, signal)),
    graphCoverage: (request, signal) => client.graphCoverage(request, signal),
    derivedNeighbors: (request, signal) => (calls.push('derivedNeighbors'), client.derivedNeighbors(request, signal)),
  };
  return { client: wrapped, calls };
}

const openRow = async (title: string): Promise<void> => userEvent.setup().click(await screen.findByRole('link', { name: title }));
const go = (view: ReturnType<typeof renderApp>, to: number | string) => act(async () => (typeof to === 'number' ? view.router.navigate(to) : view.router.navigate(to)));
const home = async (view: ReturnType<typeof renderApp>): Promise<void> => {
  await go(view, '/');
  await screen.findByRole('heading', { name: 'Recent', level: 2 });
};
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const sourceLine = (): string => document.querySelector('section[aria-label="Source"]')?.textContent ?? '';

describe('going Back and Forward between investigations opened from Recent', () => {
  it('shows each as it was, with no read of the investigation or its entity, while Home reads its list and the profiles of its rows at each arrival', async () => {
    const watched = recording(knowing([A, B]).client);
    const view = renderApp('/', watched.client, createClientState());
    await openRow('kind-a A-1');
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await home(view);
    await openRow('kind-a C-1');
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    await screen.findByText('1 entity · 0 relationships · loaded · exact');
    const since = (): string[] => watched.calls.splice(0).filter((call) => call !== 'saveDraft');
    since();
    const arrivalAtHome = ['getProfile source-a', 'getProfile source-b', 'listInvestigations'];
    for (let round = 0; round < 3; round += 1) {
      await go(view, -1);
      expect(await screen.findByRole('heading', { name: 'Recent', level: 2 })).toBeTruthy();
      await settle();
      expect(since().sort(), 'Home reads its list and the profile of each source among its rows').toEqual(arrivalAtHome);
      await go(view, -1);
      expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
      expect(sourceLine()).toContain('Source source-a');
      await settle();
      expect(since(), 'the first investigation returns with the profile of its source read again, and nothing else').toEqual(['getProfile source-a']);
      await go(view, 1);
      await screen.findByRole('heading', { name: 'Recent', level: 2 });
      await settle();
      expect(since().sort()).toEqual(arrivalAtHome);
      await go(view, 1);
      expect(await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 })).toBeTruthy();
      expect(sourceLine()).toContain('Source source-b');
      await settle();
      expect(since(), 'the second investigation returns with the profile of its source read again, and nothing else').toEqual(['getProfile source-b']);
    }
  });

  it('shows an investigation opened elsewhere on the next visit to Home, and the earlier rows meanwhile', async () => {
    let items = [listItemOf(A.investigation)];
    const parts = knowing([A, B, NEWER], { listInvestigations: async () => ({ ok: true, value: listOf(items) }) });
    const view = renderApp('/', parts.client, createClientState());
    await screen.findByRole('link', { name: 'kind-a A-1' });
    await go(view, '/sources');
    items = [listItemOf(NEWER.investigation), listItemOf(A.investigation)];
    await home(view);
    expect(await screen.findByRole('link', { name: 'kind-a N-1' })).toBeTruthy();
    expect(document.querySelectorAll('.recent-row')).toHaveLength(2);
  });

  it('lists the rows the endpoint answers: an older investigation that was only resumed stays outside the five most recent', async () => {
    const list = [listItemOf(NEWER.investigation), listItemOf(A.investigation)];
    const parts = knowing([A, B, NEWER, OLDER], { listInvestigations: async () => ({ ok: true, value: listOf(list, true) }) });
    const view = renderApp('/', parts.client, createClientState());
    await screen.findByRole('link', { name: 'kind-a N-1' });
    await go(view, '/source-a/entity/kind-a/OLD-1');
    await screen.findByRole('heading', { name: 'kind-a OLD-1', level: 1 });
    await home(view);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect([...document.querySelectorAll('.recent-row')].map((row) => row.querySelector('a')?.textContent)).toEqual(['kind-a N-1', 'kind-a A-1']);
    expect(screen.queryByRole('link', { name: 'kind-a OLD-1' })).toBeNull();
  });

  it('reads a profile that failed and a profile that was read again at the next visit', async () => {
    let failures = 1;
    const asked: string[] = [];
    const parts = knowing([A, B], {
      getProfile: async (sourceId: string) => {
        asked.push(sourceId);
        if (sourceId === 'source-b' && failures > 0) {
          failures -= 1;
          return { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };
        }
        return { ok: true, value: testProfile(sourceId) };
      },
    });
    const view = renderApp('/', parts.client, createClientState());
    await screen.findByRole('link', { name: 'kind-a C-1' });
    await settle();
    await go(view, '/sources');
    await screen.findByRole('heading', { name: 'Sources', level: 1 });
    asked.length = 0;
    await home(view);
    await settle();
    expect([...asked].sort()).toEqual(['source-a', 'source-b']);
  });
});
