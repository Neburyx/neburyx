import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { InvestigationListResponse, SourceSummary } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { fakeClient } from '../api/fake-client.js';
import type { RequestState } from '../api/use-request.js';
import { INVESTIGATION_A, investigationOf, listItemOf, listOf } from '../investigations/test-data.js';
import { createShellData, ShellDataProvider } from '../shell/shell-data.js';
import { createStore, readable } from '../state/store.js';
import { source } from '../test-utils.js';
import { RecentProvider } from './recent-context.js';
import { RecentList } from './recent-list.js';
import type { RecentInvestigations, RecentState } from './recent-store.js';

type ListState = RequestState<InvestigationListResponse>;
const FAILURE = { code: 'NETWORK_UNAVAILABLE' } as const;
const EMPTY = listOf([]);
const WITH_ROW = listOf([listItemOf(investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1'))]);
const demo = source('source-a', { synthetic: true, demoCase: { entityType: 'kind-a', stableId: 'A-1', caseRef: 'CASE-1' } });

/** Recent's list on a list state the test sets and changes, with the sources the shell holds. */
async function showing(list: ListState, sources: readonly SourceSummary[] = [source('source-a', { synthetic: false })]) {
  const state = createStore<RecentState>({ list, profiles: new Map(), readBy: undefined });
  const calls = { reloads: 0 };
  const recent: RecentInvestigations = { ...readable(state), ensure: () => undefined, reload: () => void (calls.reloads += 1) };
  const shell = createShellData(fakeClient({ getSources: async () => ({ ok: true, value: { items: [...sources], nextCursor: null } }), getMe: async () => ({ ok: false, failure: FAILURE }) }));
  render(
    <MemoryRouter>
      <ShellDataProvider store={shell}>
        <RecentProvider recent={recent}>
          <RecentList />
        </RecentProvider>
      </ShellDataProvider>
    </MemoryRouter>,
  );
  await act(async () => undefined);
  return { set: (next: ListState) => act(() => state.setState({ list: next, profiles: new Map(), readBy: undefined })), calls };
}

const emptyTitle = (): HTMLElement | null => screen.queryByRole('heading', { name: 'No investigations yet', level: 3 });

describe('Recent with no investigation', () => {
  it('shows the empty state in the place of the rows, with its title and sentence, no button of its own, and not the old line', async () => {
    await showing({ phase: 'ready', data: EMPTY });
    expect(emptyTitle()).toBeTruthy();
    const region = screen.getByRole('region', { name: 'No investigations yet' });
    expect(within(region).queryByRole('button')).toBeNull();
    expect(screen.queryByText('No recent investigations.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Recent', level: 2 })).toBeTruthy();
  });

  it('names the demo case in its sentence only when a demo action is offered, and never offers Connect your Neo4j', async () => {
    await showing({ phase: 'ready', data: EMPTY }, [demo]);
    expect(screen.getByText('Open the demo case, search for an entity or open a deep link.')).toBeTruthy();
    expect(screen.queryByText(/Connect/)).toBeNull();
  });

  it('says to search or open a deep link when no source offers a demo case', async () => {
    await showing({ phase: 'ready', data: EMPTY }, [source('source-a', { synthetic: true }), source('source-b', { synthetic: false })]);
    expect(screen.getByText('Search for an entity or open a deep link.')).toBeTruthy();
    expect(screen.queryByText(/demo case/)).toBeNull();
    expect(screen.queryByText(/Connect/)).toBeNull();
  });
});

describe('Recent while the list is not answered or is read again', () => {
  it('shows the loading line and no empty state before the list has an answer', async () => {
    await showing({ phase: 'loading' });
    expect(screen.getByText('Loading recent investigations…')).toBeTruthy();
    expect(emptyTitle()).toBeNull();
  });

  it('keeps the empty state with the loading line when an answer of no investigation is read again, and with the notice and Try again when that read fails', async () => {
    const { set, calls } = await showing({ phase: 'ready', data: EMPTY });
    await set({ phase: 'loading', data: EMPTY });
    expect(emptyTitle()).toBeTruthy();
    expect(screen.getByText('Loading recent investigations…')).toBeTruthy();
    await set({ phase: 'ready', data: EMPTY, failure: FAILURE });
    expect(emptyTitle()).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('NETWORK_UNAVAILABLE');
    act(() => screen.getByRole('button', { name: 'Try again' }).click());
    expect(calls.reloads).toBe(1);
  });

  it('shows the failure block and no empty state when the first read failed', async () => {
    await showing({ phase: 'failed', failure: FAILURE });
    expect(screen.getByText('Recent investigations could not be read.')).toBeTruthy();
    expect(emptyTitle()).toBeNull();
  });

  describe.each([
    ['index-unavailable', 'A needed index is not there, so the read was not run.', false],
    ['index-building', 'A needed index is still building, so the read is slow. Try again later.', true],
  ] as const)('for an unavailable source with the reason %s', (reason, message, retryable) => {
    const unavailable = { code: 'SOURCE_UNAVAILABLE', message, retryable, traceId: 'tr-recent', details: { reason } } as const;

    it(`names it by its sentence and ${retryable ? 'offers' : 'offers no'} Try again when the first read failed`, async () => {
      const { calls } = await showing({ phase: 'failed', failure: unavailable });
      expect(screen.getByText('Recent investigations could not be read.')).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toBe(`${message} · trace tr-recent`);
      const tryAgain = screen.queryByRole('button', { name: 'Try again' });
      expect(tryAgain !== null).toBe(retryable);
      if (tryAgain !== null) act(() => tryAgain.click());
      expect(calls.reloads).toBe(retryable ? 1 : 0);
    });

    it(`keeps the rows, names it by its sentence and ${retryable ? 'offers' : 'offers no'} Try again when a read again failed`, async () => {
      await showing({ phase: 'ready', data: WITH_ROW, failure: unavailable });
      expect(screen.getByRole('link', { name: 'kind-a A-1' })).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toBe(`${message} · trace tr-recent`);
      expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(retryable);
    });
  });

  it('shows the rows and no empty state for an answer that holds an investigation', async () => {
    await showing({ phase: 'ready', data: WITH_ROW });
    expect(screen.getByRole('link', { name: 'kind-a A-1' })).toBeTruthy();
    expect(emptyTitle()).toBeNull();
  });
});
