import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { READ_WAIT_MS } from '../api/read-wait.js';
import { testProfile } from '../dev/test-profile.js';
import { INVESTIGATION_A, investigationOf, listItemOf, listOf } from '../investigations/test-data.js';
import { listOf as templatesOf } from '../patterns/patterns-kit.js';
import { searchAt } from '../search/search-test-kit.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wait = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const hang = () => new Promise<never>(() => undefined);
const UNREACHABLE = 'The server could not be reached.';
const press = async (element: HTMLElement) => {
  await act(async () => void fireEvent.click(element));
  await wait();
};
const region = (name: string) => screen.getByRole('region', { name });
const ROW = listItemOf(investigationOf(INVESTIGATION_A, 'a', 'kind-a', 'A-1'));

/** A client of one source whose first read of each named kind gets no answer. */
function home(hung: readonly ('sources' | 'list' | 'profile' | 'templates')[], rows = [ROW]) {
  const calls = { sources: 0, list: 0, profile: 0, templates: 0 };
  const profileSignals: (AbortSignal | undefined)[] = [];
  const answered = <T,>(kind: keyof typeof calls, value: T) => {
    calls[kind] += 1;
    return calls[kind] === 1 && hung.includes(kind) ? hang() : Promise.resolve({ ok: true as const, value });
  };
  const client: ApiClient = {
    ...clientWith({ me: me() }),
    getSources: () => answered('sources', { items: [source('a', { alias: 'alpha' })], nextCursor: null }),
    listInvestigations: () => answered('list', listOf(rows)),
    getProfile: (sourceId, signal) => (profileSignals.push(signal), answered('profile', testProfile(sourceId))),
    listTemplates: () => answered('templates', templatesOf()),
  };
  return { client, calls, profileSignals };
}

describe('Home: a read that gets no answer', () => {
  it('leaves the loading start page at the bound and shows the recent list as not read, with Try again', async () => {
    const { client, calls } = home(['list']);
    renderApp('/', client);
    await wait(READ_WAIT_MS - 1);
    expect(within(screen.getByRole('main')).getByRole('status').textContent).toBe('Loading…');
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    await wait(1);
    const recent = region('Recent');
    expect(within(recent).getByText(UNREACHABLE)).toBeTruthy();
    expect(within(recent).queryByText('Loading recent investigations…')).toBeNull();
    await press(within(recent).getByRole('button', { name: 'Try again' }));
    expect(calls.list).toBe(2);
    expect(within(region('Recent')).getByRole('link', { name: ROW.title })).toBeTruthy();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
  });

  it('shows a row with what is stored once its source profile is given up, with no message, and reads the profile at the next visit', async () => {
    const { client, calls, profileSignals } = home(['profile']);
    const view = renderApp('/', client);
    await wait();
    await wait(READ_WAIT_MS - 1);
    expect(calls.profile).toBe(1);
    expect(profileSignals[0]?.aborted).toBe(false);
    await wait(1);
    expect(profileSignals[0]?.aborted).toBe(true);
    expect(within(region('Recent')).getByText('kind-a')).toBeTruthy();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    await act(async () => void (await view.router.navigate('/investigations')));
    await act(async () => void (await view.router.navigate('/')));
    await wait();
    expect(calls.profile).toBeGreaterThan(1);
    expect(within(region('Recent')).getByText('KIND-A')).toBeTruthy();
  });

  it('shows the pattern card as not read at the bound, and reads the patterns on Try again', async () => {
    const { client, calls } = home(['templates']);
    renderApp('/', client);
    await wait();
    const card = () => region('Start from a pattern');
    await wait(READ_WAIT_MS - 1);
    expect(within(card()).getByRole('status').textContent).toBe('Loading patterns…');
    expect(within(card()).queryByRole('alert')).toBeNull();
    await wait(1);
    expect(within(card()).getByRole('alert').textContent).toContain(UNREACHABLE);
    await press(within(card()).getByRole('button', { name: 'Try again' }));
    expect(calls.templates).toBe(2);
    expect(within(card()).getByRole('button', { name: 'Run Shared devices' })).toBeTruthy();
    expect(within(card()).queryByRole('alert')).toBeNull();
  });

  it('shows the sources as not read in the Source health card at the bound, and reads them on Try again', async () => {
    const { client, calls } = home(['sources']);
    renderApp('/', client);
    await wait();
    const card = () => region('Source health');
    await wait(READ_WAIT_MS - 1);
    expect(within(card()).getByRole('status')).toBeTruthy();
    expect(within(card()).queryByText(UNREACHABLE)).toBeNull();
    await wait(1);
    expect(within(card()).getByText(UNREACHABLE)).toBeTruthy();
    expect(within(card()).queryByRole('status')).toBeNull();
    await press(within(card()).getByRole('button', { name: 'Try again' }));
    expect(calls.sources).toBe(2);
    expect(within(card()).getByRole('heading', { name: 'alpha', level: 3 })).toBeTruthy();
    expect(within(card()).queryByText(UNREACHABLE)).toBeNull();
  });

  it('leaves the first-visit loading page at the bound when the sources, which decide it, get no answer', async () => {
    const { client } = home(['sources'], []);
    renderApp('/', client);
    await wait(READ_WAIT_MS - 1);
    expect(within(screen.getByRole('main')).getByRole('status').textContent).toBe('Loading…');
    expect(screen.queryByRole('region', { name: 'Source health' })).toBeNull();
    await wait(1);
    expect(within(region('Source health')).getByText(UNREACHABLE)).toBeTruthy();
    expect(within(screen.getByRole('main')).queryByText('Loading…')).toBeNull();
  });

  it('shows the Search page as not read at the bound when the sources get no answer, and reads them on Try again', async () => {
    const { client, calls } = home(['sources']);
    renderApp(searchAt('a'), client);
    await wait(READ_WAIT_MS - 1);
    expect(within(screen.getByRole('main')).getByRole('status')).toBeTruthy();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    await wait(1);
    const main = within(screen.getByRole('main'));
    expect(main.getByText(UNREACHABLE)).toBeTruthy();
    await press(main.getByRole('button', { name: 'Try again' }));
    expect(calls.sources).toBe(2);
    expect(within(screen.getByRole('main')).getByRole('searchbox')).toBeTruthy();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
  });
});
