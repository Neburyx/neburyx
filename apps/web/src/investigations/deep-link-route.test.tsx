import { act, configure, screen, waitFor } from '@testing-library/react';
import type { OpenInvestigationRequest } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftSyncOf } from '../draft/draft-sync.js';
import { createClientState } from '../state/client-state.js';
import { renderApp } from '../test-utils.js';
import { deepLinkPath } from './deep-link.js';
import { OPENING_LINK, RESUMED } from './messages.js';
import { entityIdOf, INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf, openedOf } from './test-data.js';

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

function recording(known = [A, B], answer?: (request: OpenInvestigationRequest) => Promise<void>) {
  const sent: OpenInvestigationRequest[] = [];
  const parts = knowing(known, {
    openInvestigation: async (request) => {
      sent.push(request);
      await answer?.(request);
      const found = known.find((entry) => entry.node.ref.sourceId === request.entity.sourceId && entry.node.ref.stableId === entityIdOf(request.entity));
      return found === undefined ? { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-1' } } : { ok: true, value: openedOf(found.investigation, found.node, true) };
    },
  });
  return { ...parts, sent };
}

const link = (sourceId: string, entityType: string, stableId: string, caseRef?: string): string => deepLinkPath({ sourceId, entityType, stableId, ...(caseRef === undefined ? {} : { caseRef }) });

describe('following a link', () => {
  it('sends one open with the three parts and the case reference, shows the entity of its investigation, and replaces the link in the history', async () => {
    const { client, sent } = recording();
    const view = renderApp(link('source-a', 'kind-a', 'A-1', 'CASE-1'), client);
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(sent).toEqual([{ sourceId: 'source-a', entity: { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' }, caseRef: 'CASE-1', mask: false }]);
    expect(screen.getByText('CASE-1')).toBeTruthy();
    expect(view.router.state.location.pathname).toBe(`/explore/${INVESTIGATION_A}`);
    expect(view.router.state.historyAction).toBe('REPLACE');
  });

  it('sends one open when the link is followed from a page whose shell data is already read, as the replayed effect of StrictMode would otherwise send two', async () => {
    const { client, sent } = recording();
    const view = renderApp('/sources', client);
    await screen.findByRole('heading', { name: 'Sources', level: 1 });
    await act(async () => view.router.navigate(link('source-a', 'kind-a', 'A-1')));
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(sent).toHaveLength(1);
  });

  it('sends no case reference for a link without one, and still only one open', async () => {
    const { client, sent } = recording();
    renderApp(link('source-b', 'kind-a', 'C-1'), client);
    expect(await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 })).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('caseRef');
  });

  it('opens the entity of a link whose type or stable ID is dots only, has a slash, a percent sign, a space or a non-ASCII letter', async () => {
    for (const stableId of ['.', '..', '~', 'a/b', '100%', 'a b', 'Zoë', '%2F', '~..']) {
      const odd = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', stableId), node: nodeOf('source-a', 'kind-a', stableId) };
      const { client, sent } = recording([odd]);
      const view = renderApp(link('source-a', 'kind-a', stableId), client);
      await waitFor(() => expect(view.router.state.location.pathname).toBe(`/explore/${INVESTIGATION_A}`));
      expect(sent.map((request) => entityIdOf(request.entity)), stableId).toEqual([stableId]);
      view.unmount();
    }
    const odd = { investigation: investigationOf(INVESTIGATION_A, 'source-a', '..', 'X-1'), node: nodeOf('source-a', '..', 'X-1') };
    const { client, sent } = recording([odd]);
    renderApp(link('source-a', '..', 'X-1'), client);
    await screen.findByRole('heading', { level: 1 });
    expect(sent[0]?.entity.entityType).toBe('..');
  });

  it('brings back the investigation the session holds, with the notice, when the answer says an existing one was opened', async () => {
    const parts = knowing([A], { openInvestigation: async () => ({ ok: true, value: openedOf(A.investigation, A.node, false) }) });
    const state = createClientState();
    const key = { sourceId: 'source-a', principalId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', policyVersion: 'community', filterHash: 'none', params: `open:${INVESTIGATION_A}`, mask: false };
    const added = nodeOf('source-a', 'kind-a', 'A-2');
    state.show({ id: INVESTIGATION_A, sourceId: 'source-a', record: { title: 'kind-a A-1', caseRef: 'CASE-1', status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key], nodeRefs: [A.node.ref, added.ref], edgeRefs: [] }, [{ key, result: { sourceId: 'source-a', nodes: [A.node, added], edges: [] } }]);
    renderApp(link('source-a', 'kind-a', 'A-1', 'CASE-1'), parts.client, state);
    expect(await screen.findByText(RESUMED)).toBeTruthy();
    expect(screen.getByText('2 entities · 0 relationships · loaded · exact')).toBeTruthy();
  });

  it('shows the second source and leaves the first investigation as it was, naming the first source until the second is shown', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { client } = recording([A, B], async (request) => {
      if (request.sourceId === 'source-b') await slow;
    });
    const state = createClientState();
    const view = renderApp(link('source-a', 'kind-a', 'A-1', 'CASE-1'), client, state);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await act(async () => void (await draftSyncOf(state, client).settle()));
    const first = state.investigation.getState();
    await act(async () => view.router.navigate(link('source-b', 'kind-a', 'C-1')));
    expect(screen.getByRole('status').textContent).toBe(OPENING_LINK);
    expect(document.querySelector('section[aria-label="Source"]')?.textContent).toContain('Source source-a');
    expect(state.investigation.getState()).toBe(first);
    await act(async () => {
      release();
      await slow;
    });
    expect(await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 })).toBeTruthy();
    expect(document.querySelector('section[aria-label="Source"]')?.textContent).toContain('Source source-b');
    expect(state.holds(INVESTIGATION_A, false)).toBe(true);
  });

  it('shows the later link and ignores the answer that comes late for the earlier one', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { client, sent } = recording([A, B], async (request) => {
      if (request.sourceId === 'source-a') await slow;
    });
    const state = createClientState();
    const view = renderApp('/sources', client, state);
    await act(async () => view.router.navigate(link('source-a', 'kind-a', 'A-1')));
    await act(async () => view.router.navigate(link('source-b', 'kind-a', 'C-1')));
    expect(await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 })).toBeTruthy();
    await act(async () => {
      release();
      await slow;
    });
    expect(state.investigation.getState().id).toBe(INVESTIGATION_B);
    expect(view.router.state.location.pathname).toBe(`/explore/${INVESTIGATION_B}`);
    expect(sent).toHaveLength(2);
  });

  it('shows Opening the link, not the message page of the earlier link, while a new link is read, and then its own result', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { client } = recording([A, B], async (request) => {
      if (request.sourceId === 'source-b') await slow;
    });
    const view = renderApp('/sources', client);
    await screen.findByRole('heading', { name: 'Sources', level: 1 });
    await act(async () => view.router.navigate(link('source-a', 'kind-a', 'missing')));
    await screen.findByRole('heading', { name: 'Nothing was found at this link', level: 1 });
    await act(async () => view.router.navigate(link('source-b', 'kind-a', 'C-1')));
    expect(screen.queryByRole('heading', { name: 'Nothing was found at this link' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(OPENING_LINK);
    await act(async () => {
      release();
      await slow;
    });
    expect(await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 })).toBeTruthy();
  });

  it('sends no further open on a reload-like return: Back to the page that followed the link and Forward again', async () => {
    const { client, sent } = recording();
    const view = renderApp('/sources', client);
    await act(async () => view.router.navigate(link('source-a', 'kind-a', 'A-1')));
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await act(async () => view.router.navigate(-1));
    await screen.findByRole('heading', { name: 'Sources', level: 1 });
    await act(async () => view.router.navigate(1));
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(sent).toHaveLength(1);
  });
});
