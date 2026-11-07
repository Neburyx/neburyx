import { INVESTIGATION_A, investigationOf, listItemOf, listOf } from '../investigations/test-data.js';
import { act, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SourceSummary } from '@neburyx/contracts';
import { fakeClient } from '../api/fake-client.js';
import type { ApiClient } from '../api/client.js';
import { me, renderApp, source, testReport } from '../test-utils.js';
import { testProfile } from '../dev/test-profile.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const ROW = listItemOf(investigationOf(INVESTIGATION_A, 'a', 'kind-a', 'A-1'));

const STORED = {
  checkedAt: '2026-10-30T10:16:08.000Z',
  outcome: 'pass' as const,
  server: { product: 'Neo4j Kernel', version: '5.26.32' },
  versionSupported: true,
  readOnlyCheck: 'privileges-inspected' as const,
  loginCanWrite: false,
  degreeStatus: 'pass' as const,
  degreeWarnings: [],
};

const alpha = source('a', { alias: 'alpha', lastTest: STORED, lastTestAt: STORED.checkedAt, mappingSummary: { entityTypes: 8, relationshipTypes: 12, derivedRules: 1 } });
const beta = source('b', { alias: 'beta' });
const gamma = source('c', { alias: 'gamma', lastTestAt: '2026-10-29T08:00:00.000Z' });

function homeClient(reads: Array<readonly SourceSummary[] | 'pending'>, overrides: Partial<ApiClient> = {}): { readonly client: ApiClient; readonly calls: { sources: number; list: number } } {
  const calls = { sources: 0, list: 0 };
  const client = fakeClient({
    getMe: async () => ({ ok: true, value: me() }),
    getSources: async () => {
      const read = reads[Math.min(calls.sources, reads.length - 1)];
      calls.sources += 1;
      if (read === 'pending') return new Promise<never>(() => undefined);
      return { ok: true, value: { items: [...(read ?? [])], nextCursor: null } };
    },
    getProfile: async (sourceId) => ({ ok: true, value: testProfile(sourceId) }),
    listInvestigations: async () => {
      calls.list += 1;
      return { ok: true, value: listOf([ROW]) };
    },
    ...overrides,
  });
  return { client, calls };
}

const card = (): HTMLElement => screen.getByRole('region', { name: 'Source health' });
const factsIn = (scope: HTMLElement): string[][] => within(scope).getAllByRole('term').map((term) => [term.textContent ?? '', term.nextElementSibling?.textContent ?? '']);
const blockOf = (alias: string): HTMLElement => {
  const heading = within(card()).getByRole('heading', { name: alias, level: 3 });
  const block = heading.closest('li');
  if (block === null) throw new Error('no block');
  return block;
};
const sourcesFacts = (): string[][] => factsIn(screen.getByRole('region', { name: /health$/ }));

describe('Home: the Source health card', () => {
  it('lists each source in the order the API gives, each with its alias and its state in words', async () => {
    renderApp('/', homeClient([[beta, alpha]]).client);
    await screen.findByRole('region', { name: 'Source health' });
    const headings = within(card()).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['beta', 'alpha']);
    expect(screen.getByRole('heading', { name: 'Source health', level: 2 })).toBeTruthy();
    expect(within(blockOf('alpha')).getByText('Connected')).toBeTruthy();
    expect(within(blockOf('beta')).getByText('Connected')).toBeTruthy();
  });

  it('follows the Recent list on the page', async () => {
    renderApp('/', homeClient([[alpha]]).client);
    const recent = await screen.findByRole('heading', { name: 'Recent', level: 2 });
    const health = await screen.findByRole('heading', { name: 'Source health', level: 2 });
    expect(recent.compareDocumentPosition(health) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the three facts with the text the Sources page shows for the same source, for a stored test, a never-tested source and one tested for another configuration', async () => {
    const user = userEvent.setup();
    renderApp('/', homeClient([[alpha, beta, gamma]]).client);
    await screen.findByRole('region', { name: 'Source health' });
    const onHome = new Map([alpha, beta, gamma].map((entry) => [entry.alias, factsIn(blockOf(entry.alias))]));
    expect(onHome.get('alpha')).toEqual([
      ['Last test', '30 Oct 2026, 10:16:08 UTC'],
      ['Read-only verified', 'Privileges inspected'],
      ['Mapping valid', '8 entity types · 12 relationship types · 1 derived rule'],
    ]);
    expect(onHome.get('beta')?.map(([label, value]) => `${label}: ${value}`)).toEqual(['Last test: Never tested', 'Read-only verified: Not tested yet', 'Mapping valid: 1 entity type · 1 relationship type · 0 derived rules']);
    expect(onHome.get('gamma')?.[1]).toEqual(['Read-only verified', 'Not tested with the current configuration']);

    await user.click(screen.getByRole('link', { name: 'Sources' }));
    for (const entry of [alpha, beta, gamma]) {
      await user.click(await screen.findByRole('button', { name: new RegExp(entry.alias) }));
      const onPage = sourcesFacts().filter(([label]) => label !== 'Connection');
      expect(onPage, entry.alias).toEqual(onHome.get(entry.alias));
    }
  });

  it('shows the held report of a test run on the Sources page, the same as that page, while it is newer than the stored test', async () => {
    const user = userEvent.setup();
    const parts = homeClient([[beta], 'pending'], {
      testSource: async (id) => ({ ok: true, value: testReport(id, { checkedAt: '2026-11-02T10:00:00.000Z' }) }),
    });
    renderApp('/sources', parts.client);
    await user.click(await screen.findByRole('button', { name: 'Test source' }));
    await screen.findByText('Test finished: connected');
    await user.click(screen.getByRole('link', { name: 'Home' }));
    await screen.findByRole('region', { name: 'Source health' });
    const onHome = factsIn(blockOf('beta'));
    expect(onHome).toEqual([
      ['Last test', '2 Nov 2026, 10:00:00 UTC'],
      ['Read-only verified', 'Privileges inspected'],
      ['Mapping valid', '1 entity type · 1 relationship type · 0 derived rules'],
    ]);
    await user.click(screen.getByRole('link', { name: 'Sources' }));
    expect(sourcesFacts().filter(([label]) => label !== 'Connection')).toEqual(onHome);
  });

  it('links to the Sources page, by mouse and by keyboard', async () => {
    const user = userEvent.setup();
    renderApp('/', homeClient([[alpha]]).client);
    await screen.findByRole('region', { name: 'Source health' });
    const link = within(card()).getByRole('link', { name: 'View sources →' });
    expect(link.getAttribute('href')).toBe('/sources');
    await user.click(link);
    expect(await screen.findByRole('heading', { name: 'Sources', level: 1 })).toBeTruthy();
    await user.click(screen.getByRole('link', { name: 'Home' }));
    await screen.findByRole('region', { name: 'Source health' });
    for (let presses = 0; presses < 30 && document.activeElement !== within(card()).getByRole('link', { name: 'View sources →' }); presses += 1) await user.tab();
    expect(document.activeElement).toBe(within(card()).getByRole('link', { name: 'View sources →' }));
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Sources', level: 1 })).toBeTruthy();
  });

  it('sends the sources and the identity once each and the list once, and nothing more for the card', async () => {
    const parts = homeClient([[alpha, beta]]);
    renderApp('/', parts.client);
    await screen.findByRole('region', { name: 'Source health' });
    await waitFor(() => expect(parts.calls.list).toBe(1));
    expect(parts.calls.sources).toBe(1);
    await act(async () => undefined);
    expect(parts.calls).toEqual({ sources: 1, list: 1 });
  });
});

describe('Home: the Source health card for sources that are not connected', () => {
  const reasonOf = (alias: string): string | undefined => blockOf(alias).querySelector('.source-reason')?.textContent ?? undefined;

  it.each([
    ['unavailable', 'Unavailable', 'TLS handshake failed'],
    ['degraded', 'Degraded', 'Degree counts are estimated'],
    ['unknown', 'Unknown', 'Not tested yet'],
  ] as const)('shows the state word and the reason of a %s source as the Sources page list shows them', async (state, word, reason) => {
    const user = userEvent.setup();
    renderApp('/', homeClient([[source('a', { alias: 'alpha', state, stateReason: reason })]]).client);
    await screen.findByRole('region', { name: 'Source health' });
    expect(within(blockOf('alpha')).getByText(word)).toBeTruthy();
    expect(reasonOf('alpha')).toBe(reason);
    await user.click(screen.getByRole('link', { name: 'Sources' }));
    const row = within(await screen.findByRole('list', { name: 'Configured sources' })).getByRole('button', { name: /alpha/ });
    expect(within(row).getByText(word)).toBeTruthy();
    expect(within(row).getByText(reason)).toBeTruthy();
  });

  it('shows the state word and no reason line for an unavailable source that has no reason', async () => {
    renderApp('/', homeClient([[source('a', { alias: 'alpha', state: 'unavailable', stateReason: null })]]).client);
    await screen.findByRole('region', { name: 'Source health' });
    expect(within(blockOf('alpha')).getByText('Unavailable')).toBeTruthy();
    expect(reasonOf('alpha')).toBeUndefined();
  });

  it('shows each block its own state and reason, and none on the connected one', async () => {
    renderApp('/', homeClient([[alpha, source('b', { alias: 'beta', state: 'unavailable', stateReason: 'Connection refused' })]]).client);
    await screen.findByRole('region', { name: 'Source health' });
    expect(within(blockOf('alpha')).getByText('Connected')).toBeTruthy();
    expect(reasonOf('alpha')).toBeUndefined();
    expect(within(blockOf('beta')).getByText('Unavailable')).toBeTruthy();
    expect(reasonOf('beta')).toBe('Connection refused');
  });

  it('shows every source Unavailable with its reason, keeps the Recent list and the search box, and never says no source is connected', async () => {
    const down = [source('a', { alias: 'alpha', state: 'unavailable', stateReason: 'Connection refused' }), source('b', { alias: 'beta', state: 'unavailable', stateReason: 'TLS handshake failed' })];
    renderApp('/', homeClient([down]).client);
    await screen.findByRole('region', { name: 'Source health' });
    expect(reasonOf('alpha')).toBe('Connection refused');
    expect(reasonOf('beta')).toBe('TLS handshake failed');
    expect(screen.getByRole('heading', { name: 'Recent', level: 2 })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'kind-a A-1' })).toBeTruthy();
    expect(screen.getByRole('searchbox')).toBeTruthy();
    expect(screen.queryByText(/No source connected/i)).toBeNull();
  });

  it('still shows the three facts for a source that is not connected', async () => {
    renderApp('/', homeClient([[source('a', { alias: 'alpha', state: 'unavailable', stateReason: 'Connection refused', lastTest: STORED, lastTestAt: STORED.checkedAt })]]).client);
    await screen.findByRole('region', { name: 'Source health' });
    expect(factsIn(blockOf('alpha')).map(([label]) => label)).toEqual(['Last test', 'Read-only verified', 'Mapping valid']);
    expect(factsIn(blockOf('alpha'))[0]?.[1]).toBe('30 Oct 2026, 10:16:08 UTC');
  });
});

describe('Home: the Source health card while the sources are not read', () => {
  const failing = (answers: Array<'fail' | readonly SourceSummary[] | 'pending'>) => {
    let reads = 0;
    const client = fakeClient({
      getMe: async () => ({ ok: true, value: me() }),
      getProfile: async (sourceId) => ({ ok: true, value: testProfile(sourceId) }),
      listInvestigations: async () => ({ ok: true, value: listOf([ROW]) }),
      getSources: async () => {
        const answer = answers[Math.min(reads, answers.length - 1)];
        reads += 1;
        if (answer === 'pending') return new Promise<never>(() => undefined);
        return answer === 'fail' || answer === undefined ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : { ok: true, value: { items: [...answer], nextCursor: null } };
      },
    });
    return { client, reads: () => reads };
  };
  const region = (): HTMLElement => screen.getByRole('region', { name: 'Source health' });

  it('says the sources are loading while they are unanswered and keeps the rest of Home', async () => {
    renderApp('/', failing(['pending']).client);
    expect((await within(await screen.findByRole('region', { name: 'Source health' })).findByRole('status')).textContent).toBe('Loading sources…');
    expect(await screen.findByRole('link', { name: 'kind-a A-1' })).toBeTruthy();
  });

  it('shows the failure with its code and Try again in the card, keeps the rest of Home, and reads the sources once more when it is activated', async () => {
    const user = userEvent.setup();
    const parts = failing(['fail', [alpha]]);
    renderApp('/', parts.client);
    await within(await screen.findByRole('region', { name: 'Source health' })).findByText('The sources could not be read.');
    expect(within(region()).getByRole('alert').textContent).toContain('NETWORK_UNAVAILABLE');
    expect(screen.getByRole('heading', { name: 'Recent', level: 2 })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'kind-a A-1' })).toBeTruthy();
    expect(within(region()).queryByRole('link', { name: 'View sources →' })).toBeNull();
    expect(parts.reads()).toBe(1);
    expect(within(region()).getByRole('button', { name: 'Try again' }).className).toBe('secondary');
    await user.click(within(region()).getByRole('button', { name: 'Try again' }));
    expect(await within(region()).findByRole('heading', { name: 'alpha', level: 3 })).toBeTruthy();
    expect(parts.reads()).toBe(2);
    expect(within(region()).queryByRole('alert')).toBeNull();
  });

  it('keeps the blocks, shows the failure code and offers Try again when a later read fails', async () => {
    const user = userEvent.setup();
    const parts = failing([[alpha], 'fail', [alpha]]);
    renderApp('/sources', { ...parts.client, testSource: async (id) => ({ ok: true, value: testReport(id) }) });
    await user.click(await screen.findByRole('button', { name: 'Test source' }));
    await waitFor(() => expect(parts.reads()).toBe(2));
    await user.click(screen.getByRole('link', { name: 'Home' }));
    const scope = within(await screen.findByRole('region', { name: 'Source health' }));
    expect(scope.getByRole('heading', { name: 'alpha', level: 3 })).toBeTruthy();
    expect(scope.getByRole('alert').textContent).toContain('NETWORK_UNAVAILABLE');
    await user.click(scope.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(scope.queryByRole('alert')).toBeNull());
    expect(parts.reads()).toBe(3);
    expect(scope.getByRole('heading', { name: 'alpha', level: 3 })).toBeTruthy();
  });

  it.each([
    ['index-unavailable', 'A needed index is not there, so the read was not run.', false],
    ['index-building', 'A needed index is still building, so the read is slow. Try again later.', true],
  ] as const)('names an unavailable source with the reason %s by its sentence in the card, and offers Try again only when a retry can help', async (reason, message, retryable) => {
    let reads = 0;
    const client = fakeClient({
      getMe: async () => ({ ok: true, value: me() }),
      getProfile: async (sourceId) => ({ ok: true, value: testProfile(sourceId) }),
      listInvestigations: async () => ({ ok: true, value: listOf([ROW]) }),
      getSources: async () => {
        reads += 1;
        return reads === 1 ? { ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message, retryable, traceId: 'tr-health', details: { reason } } } : { ok: true, value: { items: [alpha], nextCursor: null } };
      },
    });
    renderApp('/', client);
    await within(await screen.findByRole('region', { name: 'Source health' })).findByText('The sources could not be read.');
    expect(within(region()).getByRole('alert').textContent).toBe(`${message} · trace tr-health`);
    const tryAgain = within(region()).queryByRole('button', { name: 'Try again' });
    expect(tryAgain !== null).toBe(retryable);
    if (tryAgain === null) return;
    await userEvent.setup().click(tryAgain);
    expect(await within(region()).findByRole('heading', { name: 'alpha', level: 3 })).toBeTruthy();
  });

  it('says no sources are configured for an empty list, with no block and the link kept', async () => {
    renderApp('/', failing([[]]).client);
    const scope = within(await screen.findByRole('region', { name: 'Source health' }));
    expect(await scope.findByText('No sources are configured.')).toBeTruthy();
    expect(scope.queryAllByRole('heading', { level: 3 })).toEqual([]);
    expect(scope.getByRole('link', { name: 'View sources →' })).toBeTruthy();
  });
});
