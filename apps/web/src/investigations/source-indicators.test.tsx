import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { draftSyncOf } from '../draft/draft-sync.js';
import { createClientState } from '../state/client-state.js';
import { renderApp, source } from '../test-utils.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf } from './test-data.js';

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };

const sourceText = (): string | null => document.querySelector('section[aria-label="Source"]')?.textContent ?? null;
const headingSource = (): string | null => document.querySelector('.page-heading .source-note')?.textContent ?? null;
const hasBadge = (): boolean => document.querySelector('.header-badge, .page-heading .badge') !== null && screen.queryAllByText('Synthetic data').length > 0;

interface Snapshot {
  readonly title: string | null;
  readonly source: string | null;
}

/** What the header shows after every batch of changes to the page, so a render that mixes two investigations cannot pass unseen. */
function watching(): { readonly snapshots: Snapshot[]; readonly stop: () => void } {
  const snapshots: Snapshot[] = [];
  const observer = new MutationObserver(() => snapshots.push({ title: document.querySelector('h1')?.textContent ?? null, source: sourceText() }));
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return { snapshots, stop: () => observer.disconnect() };
}

const mixed = (snapshots: readonly Snapshot[]): Snapshot[] =>
  snapshots.filter((shot) => (shot.title === 'kind-a A-1' && shot.source?.includes('source-b') === true) || (shot.title === 'kind-a C-1' && shot.source?.includes('source-a') === true));

let stopWatching: () => void = () => undefined;
afterEach(() => stopWatching());

async function onFirst(overrides = {}) {
  const known = knowing([A, B], overrides);
  const state = createClientState();
  const view = renderApp(`/explore/${INVESTIGATION_A}`, known.client, state);
  await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
  return { ...known, state, view };
}

const go = (view: { router: { navigate: (to: string) => Promise<void> } }, to: string) => act(async () => view.router.navigate(to));

describe('the source of an investigation that is opened from another source', () => {
  it('is named by the header in the same render that shows the second investigation, and again by the first when the person returns', async () => {
    const { view } = await onFirst();
    expect(sourceText()).toContain('Source source-a');
    const watched = watching();
    stopWatching = watched.stop;
    await go(view, `/explore/${INVESTIGATION_B}`);
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    expect(sourceText()).toContain('Source source-b');
    await go(view, `/explore/${INVESTIGATION_A}`);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(sourceText()).toContain('Source source-a');
    expect(watched.snapshots.length).toBeGreaterThan(1);
    expect(mixed(watched.snapshots)).toEqual([]);
  });

  it('is named by the status line and the page heading of a page-shell page reached after the switch, and by the first again after the return', async () => {
    const { view } = await onFirst();
    await go(view, `/explore/${INVESTIGATION_B}`);
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    await go(view, '/sources');
    await screen.findByRole('heading', { name: 'Sources', level: 1 });
    expect(sourceText()).toContain('Source source-b · read-only · connected');
    expect(headingSource()).toContain('Source source-b · read-only');
    await go(view, `/explore/${INVESTIGATION_A}`);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await go(view, '/sources');
    await screen.findByRole('heading', { name: 'Sources', level: 1 });
    expect(sourceText()).toContain('Source source-a · read-only · connected');
    expect(headingSource()).toContain('Source source-a · read-only');
  });

  it('shows the Synthetic data badge of the source on screen in the header and in the page heading, in both directions', async () => {
    const { view } = await onFirst({ getSources: async () => ({ ok: true, value: { items: [source('source-a'), source('source-b', { synthetic: false })], nextCursor: null } }) });
    expect(screen.queryAllByText('Synthetic data')).toHaveLength(1);
    await go(view, `/explore/${INVESTIGATION_B}`);
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    expect(screen.queryAllByText('Synthetic data')).toHaveLength(0);
    await go(view, '/sources');
    await screen.findByRole('heading', { name: 'Sources', level: 1 });
    expect(screen.queryAllByText('Synthetic data')).toHaveLength(0);
    await go(view, `/explore/${INVESTIGATION_A}`);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(screen.queryAllByText('Synthetic data')).toHaveLength(1);
    await go(view, '/sources');
    await screen.findByRole('heading', { name: 'Sources', level: 1 });
    expect(screen.queryAllByText('Synthetic data').length).toBeGreaterThan(0);
    expect(hasBadge()).toBe(true);
  });

  it('is named by its ID with an unknown state when the list of sources does not hold it, and by its alias and state once a listed source is shown', async () => {
    const known = knowing([A, B], { getSources: async () => ({ ok: true, value: { items: [source('source-b')], nextCursor: null } }) });
    const view = renderApp(`/explore/${INVESTIGATION_A}`, known.client, createClientState());
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await waitFor(() => expect(sourceText()).toContain('source-a · read-only · unknown'));
    await go(view, `/explore/${INVESTIGATION_B}`);
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    expect(sourceText()).toContain('Source source-b · read-only · connected');
  });
});

describe('an open into another source that does not end in a shown investigation', () => {
  it('keeps naming the first source, names the second in the failure when the investigation was read and its entity was not, and leaves the first as it was', async () => {
    const { view, state, client } = await onFirst({ getEntity: async (ref: { stableId: string }) => (ref.stableId === 'A-1' ? { ok: true, value: A.node } : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    await act(async () => void (await draftSyncOf(state, client).settle()));
    const shown = state.investigation.getState();
    await go(view, `/explore/${INVESTIGATION_B}`);
    const notice = await screen.findByRole('group', { name: 'Opening failed' });
    expect(notice.textContent).toContain('NETWORK_UNAVAILABLE');
    expect(notice.textContent).toContain('Could not open in Source source-b');
    expect(sourceText()).toContain('Source source-a');
    expect(screen.getByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(state.investigation.getState()).toBe(shown);
  });

  it('names the source tried on the not-found page when the investigation was read and its entity is missing, by alias or by its ID when it is not listed, under the heading that names no source', async () => {
    const missing = knowing([A, { ...B, node: nodeOf('source-b', 'kind-a', 'C-missing') }]);
    const view = renderApp(`/explore/${INVESTIGATION_A}`, missing.client, createClientState());
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await go(view, `/explore/${INVESTIGATION_B}`);
    await screen.findByRole('heading', { name: 'Investigation not found', level: 1 });
    expect(screen.getByText('Could not open in Source source-b.')).toBeTruthy();
    expect(document.querySelector('.page-heading .source-note')).toBeNull();
    const unlisted = knowing([A, { ...B, node: nodeOf('source-b', 'kind-a', 'C-missing') }], { getSources: async () => ({ ok: true, value: { items: [source('source-a')], nextCursor: null } }) });
    renderApp(`/explore/${INVESTIGATION_B}`, unlisted.client, createClientState());
    await screen.findByText('Could not open in source-b.');
  });

  it('names no source on the not-found page of an investigation that does not exist', async () => {
    const { client } = knowing([]);
    renderApp(`/explore/${INVESTIGATION_B}`, client, createClientState());
    await screen.findByRole('heading', { name: 'Investigation not found', level: 1 });
    expect(screen.queryByText(/Could not open in/)).toBeNull();
  });

  it('names no source in the failure when the investigation itself could not be read, and keeps naming the first', async () => {
    const { view } = await onFirst({ getInvestigation: async (id: string) => (id === INVESTIGATION_A ? knowing([A]).client.getInvestigation(id) : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    await go(view, `/explore/${INVESTIGATION_B}`);
    const notice = await screen.findByRole('group', { name: 'Opening failed' });
    expect(notice.textContent).toContain('NETWORK_UNAVAILABLE');
    expect(notice.textContent).not.toContain('Could not open in');
    expect(sourceText()).toContain('Source source-a');
  });

  it('keeps naming the first source, and the first investigation, for a not-found page and for a source that is not available as it was', async () => {
    const gone = { ...B, investigation: { ...B.investigation, sourceState: 'repointed' as const } };
    const known = knowing([A, gone]);
    const view = renderApp(`/explore/${INVESTIGATION_A}`, known.client, createClientState());
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await go(view, '/explore/0192f000-0000-7000-8000-0000000000ee');
    await screen.findByRole('heading', { name: 'Investigation not found', level: 1 });
    expect(sourceText()).toContain('Source source-a');
    await go(view, `/explore/${INVESTIGATION_B}`);
    await screen.findByRole('heading', { level: 1, name: /not available as it was/ });
    expect(sourceText()).toContain('Source source-a');
    await go(view, `/explore/${INVESTIGATION_A}`);
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
  });

  it('keeps naming the first source while the answer of the second is awaited and after the person left it, and follows the one that is opened next', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { view } = await onFirst({
      getEntity: async (ref: { sourceId: string; entityType: string; stableId: string }) => {
        if (ref.stableId === 'C-1') await slow;
        return { ok: true, value: nodeOf(ref.sourceId, ref.entityType, ref.stableId) };
      },
    });
    await go(view, `/explore/${INVESTIGATION_B}`);
    expect(sourceText()).toContain('Source source-a');
    await go(view, '/sources');
    await act(async () => {
      release();
      await slow;
    });
    expect(sourceText()).toContain('Source source-a · read-only · connected');
    expect(headingSource()).toContain('Source source-a');
    await go(view, `/explore/${INVESTIGATION_B}`);
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    expect(sourceText()).toContain('Source source-b');
  });

  it('names the source it tried, in the development form that chose it, while the status line and the heading name the source on screen', async () => {
    const { view } = await onFirst();
    await go(view, '/dev/open-entity');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Source source-b' }));
    await user.type(screen.getByLabelText('Stable ID'), 'missing');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const failure = await screen.findByRole('group', { name: 'Opening failed' });
    expect(failure.textContent).toContain('NOT_FOUND');
    expect(failure.textContent).toContain('Could not open in Source source-b');
    expect(sourceText()).toContain('Source source-a · read-only');
    expect(headingSource()).toContain('Source source-a');
  });
});
