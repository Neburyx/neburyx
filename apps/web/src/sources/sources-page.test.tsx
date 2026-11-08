import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { MeResponse, SourceSummary } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createShellData, ShellDataProvider, useShellData } from '../shell/shell-data.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { clientWith, counted, me, renderApp, source, testReport } from '../test-utils.js';
import type { SourceProfile, SourceTestReport } from '@neburyx/contracts';
import { createApiClient, type ApiResult } from '../api/client.js';
import { testProfile } from '../dev/test-profile.js';
import { createExcerpts } from './excerpts.js';
import { ExcerptsProvider } from './excerpts-context.js';
import { createTestRuns } from './test-runs.js';
import { TestRunsProvider } from './test-runs-context.js';
import { SourcesPage } from './sources-page.js';

const profiled = (overrides: Partial<ApiClient> = {}): ApiClient => fakeClient({ getProfile: async (id) => ({ ok: true, value: testProfile(id) }), ...overrides });

function pendingProfile() {
  let settle: (result: ApiResult<SourceProfile>) => void = () => undefined;
  const promise = new Promise<ApiResult<SourceProfile>>((done) => {
    settle = done;
  });
  return { promise, resolve: (result: ApiResult<SourceProfile>) => settle(result) };
}

const main = () => screen.getByRole('main');
const list = () => within(main()).getByRole('list', { name: 'Configured sources' });
const rows = () => within(list()).getAllByRole('listitem');
const row = (index: number): HTMLElement => {
  const found = rows()[index];
  if (found === undefined) throw new Error(`the list has no row ${index}`);
  return found;
};
const rowButton = (index: number) => within(row(index)).getByRole('button');

function ReadAgain() {
  const { reloadSources } = useShellData();
  return <button onClick={reloadSources}>Read again</button>;
}

function Harness({ client }: { readonly client: ApiClient }) {
  const state = useMemo(() => createClientState(), []);
  const store = useMemo(() => createShellData(client), [client]);
  const runs = useMemo(() => createTestRuns(client, store), [client, store]);
  const excerpts = useMemo(() => createExcerpts(client), [client]);
  return (
    <ClientStateProvider state={state}>
      <ShellDataProvider store={store}>
        <TestRunsProvider runs={runs}>
          <ExcerptsProvider excerpts={excerpts}>
            <MemoryRouter>
              <ReadAgain />
              <main>
                <SourcesPage />
              </main>
            </MemoryRouter>
          </ExcerptsProvider>
        </TestRunsProvider>
      </ShellDataProvider>
    </ClientStateProvider>
  );
}

function answering(answers: Array<readonly SourceSummary[] | 'fail'>, principal: MeResponse = me()): ApiClient {
  let reads = 0;
  return profiled({
    getMe: async () => ({ ok: true, value: principal }),
    getSources: async () => {
      const answer = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      return answer === 'fail' || answer === undefined ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : { ok: true, value: { items: [...answer], nextCursor: null } };
    },
  });
}

describe('the Sources page', () => {
  it('lists the sources in the order given with the alias, the state in words and the Read-only tag, under the heading and its description', async () => {
    renderApp('/sources', clientWith({ me: me(), sources: [source('a', { alias: 'alpha' }), source('b', { alias: 'beta', state: 'unavailable', stateReason: 'TLS handshake failed' })] }));
    expect(screen.getByRole('heading', { name: 'Sources', level: 1 })).toBeTruthy();
    expect(screen.getByText('Sources are defined in a config file. This page shows their health. It never edits them.')).toBeTruthy();
    await within(main()).findByRole('list', { name: 'Configured sources' });
    const [first, second] = rows();
    expect(first?.textContent).toBe('alphaConnectedRead-only');
    expect(second?.textContent).toBe('betaUnavailableTLS handshake failedRead-only');
  });

  it('shows the reason under the pill when the source has one and no placeholder when it has none', async () => {
    renderApp('/sources', clientWith({ me: me(), sources: [source('a', { alias: 'alpha', state: 'degraded', stateReason: 'estimated degree counts' }), source('b', { alias: 'beta', state: 'unknown' })] }));
    await within(main()).findByRole('list', { name: 'Configured sources' });
    expect(within(row(0)).getByText('estimated degree counts')).toBeTruthy();
    expect(row(1).textContent).toBe('betaUnknownRead-only');
  });

  it('shows the whole reason of a source, the long advice about relationship IDs too, on its row', async () => {
    const advice = 'MADE_FROM: advice: a uniqueness constraint on the stable id property `linkId` is needed for paging without a repeat or a gap';
    renderApp('/sources', clientWith({ me: me(), sources: [source('a', { alias: 'alpha', state: 'degraded', stateReason: advice })] }));
    await within(main()).findByRole('list', { name: 'Configured sources' });
    expect(within(row(0)).getByText(advice)).toBeTruthy();
  });

  it.each([
    ['connected', 'Connected', 'pill-connected'],
    ['unavailable', 'Unavailable', 'pill-unavailable'],
    ['degraded', 'Degraded', 'pill-degraded'],
    ['unknown', 'Unknown', 'pill-unknown'],
  ] as const)('draws the %s state as the word %s with the pill class %s', async (state, word, className) => {
    renderApp('/sources', clientWith({ me: me(), sources: [source('a', { state })] }));
    const pill = (await within(main()).findAllByText(word))[0];
    expect(pill?.className).toContain(className);
  });

  it('shows the footnote under the list', async () => {
    renderApp('/sources', clientWith({ me: me(), sources: [source('a')] }));
    expect(await within(main()).findByText('Health is independent of source access permissions.')).toBeTruthy();
  });

  it('selects the first source by default, marks the selected row by aria-current and shows its header in the detail', async () => {
    renderApp('/sources', clientWith({ me: me(), sources: [source('a', { alias: 'alpha' }), source('b', { alias: 'beta', state: 'unavailable' })] }));
    await within(main()).findByRole('list', { name: 'Configured sources' });
    const [first, second] = rows().map((row) => within(row).getByRole('button'));
    expect(first?.getAttribute('aria-current')).toBe('true');
    expect(second?.getAttribute('aria-current')).toBeNull();
    const detail = screen.getByRole('region', { name: 'alpha health' });
    expect(within(detail).getByRole('heading', { name: 'alpha', level: 2 })).toBeTruthy();
    expect(within(detail).getByText('Connected')).toBeTruthy();
    expect(within(detail).getByText('Read-only')).toBeTruthy();
  });

  it('selects a row with a click, with Enter and with Space', async () => {
    renderApp('/sources', clientWith({ me: me(), sources: [source('a', { alias: 'alpha' }), source('b', { alias: 'beta', state: 'unavailable' }), source('c', { alias: 'gamma' })] }));
    await within(main()).findByRole('list', { name: 'Configured sources' });
    const user = userEvent.setup();
    await user.click(rowButton(1));
    expect(screen.getByRole('region', { name: 'beta health' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'beta health' })).getByText('Unavailable')).toBeTruthy();
    const third = rowButton(2);
    third.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('region', { name: 'gamma health' })).toBeTruthy();
    const first = rowButton(0);
    first.focus();
    await user.keyboard(' ');
    expect(screen.getByRole('region', { name: 'alpha health' })).toBeTruthy();
    expect(first.getAttribute('aria-current')).toBe('true');
  });

  it('keeps the selected source when the sources are read again and falls back to the first when it is gone', async () => {
    const a = source('a', { alias: 'alpha' });
    const b = source('b', { alias: 'beta' });
    render(<Harness client={answering([[a, b], [a, b], [a]])} />);
    await within(main()).findByRole('list', { name: 'Configured sources' });
    const user = userEvent.setup();
    await user.click(rowButton(1));
    await user.click(screen.getByRole('button', { name: 'Read again' }));
    expect(await screen.findByRole('region', { name: 'beta health' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Read again' }));
    expect(await screen.findByRole('region', { name: 'alpha health' })).toBeTruthy();
  });

  it('does not go back to a source that was removed from the list when it comes back, since the person did not choose it again', async () => {
    const a = source('a', { alias: 'alpha' });
    const b = source('b', { alias: 'beta' });
    render(<Harness client={answering([[a, b], [a], [a, b]])} />);
    await within(main()).findByRole('list', { name: 'Configured sources' });
    const user = userEvent.setup();
    await user.click(rowButton(1));
    await user.click(screen.getByRole('button', { name: 'Read again' }));
    expect(await screen.findByRole('region', { name: 'alpha health' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByRole('region', { name: 'alpha health' })).toBeTruthy();
    expect(rowButton(0).getAttribute('aria-current')).toBe('true');
  });

  it('keeps the source the page showed by default when the list changes, instead of going back to the first', async () => {
    const a = source('a', { alias: 'alpha' });
    const b = source('b', { alias: 'beta' });
    render(<Harness client={answering([[a, b], [b], [a, b]])} />);
    await within(main()).findByRole('list', { name: 'Configured sources' });
    expect(screen.getByRole('region', { name: 'alpha health' })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Read again' }));
    expect(await screen.findByRole('region', { name: 'beta health' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByRole('region', { name: 'beta health' })).toBeTruthy();
  });

  it('shows the failure of a later read beside an empty list', async () => {
    render(<Harness client={answering([[source('a', { alias: 'alpha' })], [], 'fail'])} />);
    await within(main()).findByRole('list', { name: 'Configured sources' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Read again' }));
    expect(await within(main()).findByText('No sources are configured.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Read again' }));
    expect((await within(main()).findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
    expect(within(main()).getByText('No sources are configured.')).toBeTruthy();
  });

  it('shows the code of a failed first read with a Try again that reads the sources again, and not the list', async () => {
    const items = [source('a', { alias: 'alpha' })];
    render(<Harness client={answering(['fail', items])} />);
    expect((await within(main()).findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
    expect(within(main()).getByText('The sources could not be read.')).toBeTruthy();
    expect(within(main()).queryByRole('list', { name: 'Configured sources' })).toBeNull();
    expect(within(main()).getByRole('button', { name: 'Try again' }).className).toBe('secondary');
    await userEvent.setup().click(within(main()).getByRole('button', { name: 'Try again' }));
    expect(await within(main()).findByRole('list', { name: 'Configured sources' })).toBeTruthy();
  });

  it('shows the trace ID of a server error on a failed first read', async () => {
    const client = profiled({ getMe: async () => ({ ok: true, value: me() }), getSources: async () => ({ ok: false, failure: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', retryable: false, traceId: 'trace-7' } }) });
    render(<Harness client={client} />);
    expect((await within(main()).findByRole('alert')).textContent).toBe('INTERNAL_ERROR · trace trace-7');
  });

  it('keeps the list as it was and shows the failure beside it when a later read fails', async () => {
    render(<Harness client={answering([[source('a', { alias: 'alpha' })], 'fail'])} />);
    await within(main()).findByRole('list', { name: 'Configured sources' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Read again' }));
    expect((await within(main()).findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'alpha health' })).toBeTruthy();
  });

  it('shows a loading state under the heading while the sources are awaited', () => {
    render(<Harness client={profiled({ getMe: async () => ({ ok: true, value: me() }), getSources: () => new Promise(() => undefined) })} />);
    expect(within(main()).getByRole('status').textContent).toBe('Loading sources…');
    expect(screen.getByRole('heading', { name: 'Sources', level: 1 })).toBeTruthy();
  });

  it('says that no sources are configured for an empty list', async () => {
    renderApp('/sources', clientWith({ me: me(), sources: [] }));
    expect(await within(main()).findByText('No sources are configured.')).toBeTruthy();
  });

  it('asks for the sources once across navigation to the page and away from it', async () => {
    const { client, calls } = counted(clientWith({ me: me(), sources: [source('a', { alias: 'alpha' })] }));
    renderApp('/', client);
    await screen.findAllByText(/alpha · read-only/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'Sources' }));
    await within(main()).findByRole('list', { name: 'Configured sources' });
    await user.click(screen.getByRole('link', { name: 'Home' }));
    await user.click(screen.getByRole('link', { name: 'Sources' }));
    expect(calls).toEqual({ me: 1, sources: 1 });
  });

  it('leaves the principal alone when only the sources are read again', async () => {
    const second = counted(clientWith({ me: me(), sources: [source('a')] }));
    render(<Harness client={second.client} />);
    await within(main()).findByRole('list', { name: 'Configured sources' });
    await act(async () => {
      await userEvent.setup().click(screen.getByRole('button', { name: 'Read again' }));
    });
    expect(second.calls).toEqual({ me: 1, sources: 2 });
  });

  describe('the health facts', () => {
    const lastTest = {
      checkedAt: '2026-10-30T10:16:08.000Z',
      outcome: 'pass' as const,
      server: { product: 'Neo4j Kernel', version: '5.26.32' },
      versionSupported: true,
      readOnlyCheck: 'privileges-inspected' as const,
      loginCanWrite: false,
      degreeStatus: 'pass' as const,
      degreeWarnings: [],
    };
    const detail = () => screen.getByRole('region', { name: /health$/ });
    const factsOf = () => within(detail()).getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent]);

    it('shows the four facts in order, from the last test, with the note under them', async () => {
      renderApp('/sources', clientWith({ me: me(), sources: [source('a', { lastTestAt: lastTest.checkedAt, lastTest, mappingSummary: { entityTypes: 8, relationshipTypes: 12, derivedRules: 1 } })] }));
      await within(main()).findByRole('list', { name: 'Configured sources' });
      expect(factsOf()).toEqual([
        ['Last test', '30 Oct 2026, 10:16:08 UTC'],
        ['Connection', 'Neo4j Kernel 5.26.32'],
        ['Read-only verified', 'Privileges inspected'],
        ['Mapping valid', '8 entity types · 12 relationship types · 1 derived rule'],
      ]);
      expect(within(detail()).getByText('Schema inventory, not individual graph relationships.')).toBeTruthy();
    });

    it('says never tested and not tested yet for a source with no test, with the mapping counts still shown', async () => {
      renderApp('/sources', clientWith({ me: me(), sources: [source('a')] }));
      await within(main()).findByRole('list', { name: 'Configured sources' });
      expect(factsOf().map(([label, value]) => `${label}: ${value}`)).toEqual(['Last test: Never tested', 'Connection: Not tested yet', 'Read-only verified: Not tested yet', 'Mapping valid: 1 entity type · 1 relationship type · 0 derived rules']);
    });

    it('says not tested with the current configuration when only a test of another one exists', async () => {
      renderApp('/sources', clientWith({ me: me(), sources: [source('a', { lastTestAt: '2026-10-30T10:16:08.000Z' })] }));
      await within(main()).findByRole('list', { name: 'Configured sources' });
      expect(factsOf().slice(0, 3)).toEqual([
        ['Last test', '30 Oct 2026, 10:16:08 UTC'],
        ['Connection', 'Not tested with the current configuration'],
        ['Read-only verified', 'Not tested with the current configuration'],
      ]);
    });

    it('shows the facts of the selected source and changes them with the selection', async () => {
      renderApp('/sources', clientWith({ me: me(), sources: [source('a', { alias: 'alpha', lastTest, lastTestAt: lastTest.checkedAt }), source('b', { alias: 'beta' })] }));
      await within(main()).findByRole('list', { name: 'Configured sources' });
      await userEvent.setup().click(rowButton(1));
      expect(factsOf()[0]).toEqual(['Last test', 'Never tested']);
    });
  });

  describe('Test source', () => {
    type Reads = Array<readonly SourceSummary[] | 'fail' | 'pending'>;

    function testable(testSource: (id: string) => Promise<ApiResult<SourceTestReport>>, reads: Reads = [[source('a', { alias: 'alpha' }), source('b', { alias: 'beta' })]]) {
      const calls: { tests: string[]; sources: number; me: number } = { tests: [], sources: 0, me: 0 };
      const client = profiled({
        getMe: async () => {
          calls.me += 1;
          return { ok: true, value: me() };
        },
        getSources: async () => {
          const read = reads[Math.min(calls.sources, reads.length - 1)];
          calls.sources += 1;
          if (read === 'pending') return new Promise<never>(() => undefined);
          return read === 'fail' || read === undefined ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : { ok: true, value: { items: [...read], nextCursor: null } };
        },
        testSource: (id) => {
          calls.tests.push(id);
          return testSource(id);
        },
      });
      return { client, calls };
    }

    const button = (name = 'Test source') => within(screen.getByRole('region', { name: /health$/ })).getByRole('button', { name });
    const facts = () => within(screen.getByRole('region', { name: /health$/ })).getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    const ok = (report: SourceTestReport): ApiResult<SourceTestReport> => ({ ok: true, value: report });

    function pendingTest() {
      let settle: (result: ApiResult<SourceTestReport>) => void = () => undefined;
      const promise = new Promise<ApiResult<SourceTestReport>>((done) => {
        settle = done;
      });
      return { promise, resolve: (result: ApiResult<SourceTestReport>) => settle(result) };
    }

    it('sends one request for the selected source when the button is clicked, and also for Enter and for Space', async () => {
      const { client, calls } = testable(async (id) => ok(testReport(id)));
      render(<Harness client={client} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      const user = userEvent.setup();
      await user.click(button());
      expect(calls.tests).toEqual(['a']);
      await user.click(rowButton(1));
      button().focus();
      await user.keyboard('{Enter}');
      expect(calls.tests).toEqual(['a', 'b']);
      await screen.findByText('Test finished: connected');
      button().focus();
      await user.keyboard(' ');
      expect(calls.tests).toEqual(['a', 'b', 'b']);
    });

    it('shows a spinner and "Testing…", marks the button busy and disabled, ignores a second activation and leaves the rest usable', async () => {
      const run = pendingTest();
      const { client, calls } = testable(() => run.promise);
      render(<Harness client={client} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      const user = userEvent.setup();
      await user.click(button());
      const busy = button('Testing…');
      expect(busy.getAttribute('aria-busy')).toBe('true');
      expect(busy.getAttribute('aria-disabled')).toBe('true');
      expect(busy.querySelector('.spinner')).not.toBeNull();
      await user.click(busy);
      expect(calls.tests).toEqual(['a']);
      await user.click(rowButton(1));
      expect(screen.getByRole('region', { name: 'beta health' })).toBeTruthy();
    });

    it('shows the report at once, asks for the sources once and not for the principal, and announces the finished test', async () => {
      const { client, calls } = testable(async (id) => ok(testReport(id, { checkedAt: '2026-11-02T10:00:00.000Z', server: { product: 'Neo4j Kernel', version: '5.26.9', edition: 'community' } })), [[source('a', { alias: 'alpha' })], 'pending']);
      render(<Harness client={client} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      await userEvent.setup().click(button());
      expect((await screen.findByRole('status', { name: '' })).textContent).toBe('Test finished: connected');
      expect(facts().slice(0, 3)).toEqual([['Last test', '2 Nov 2026, 10:00:00 UTC'], ['Connection', 'Neo4j Kernel 5.26.9'], ['Read-only verified', 'Privileges inspected']]);
      expect(calls).toMatchObject({ sources: 2, me: 1, tests: ['a'] });
    });

    it('takes the pill and the reason from the sources answer, which may differ from the report', async () => {
      const { client } = testable(async (id) => ok(testReport(id, { state: 'connected' })), [[source('a', { alias: 'alpha' })], [source('a', { alias: 'alpha', state: 'unavailable', stateReason: 'probe failed' })]]);
      render(<Harness client={client} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      await userEvent.setup().click(button());
      await within(row(0)).findByText('probe failed');
      expect(within(row(0)).getByText('Unavailable')).toBeTruthy();
      expect(screen.getByText('Test finished: connected')).toBeTruthy();
    });

    it('keeps the list and the report and shows the list failure, not a test failure, when the read after the test fails', async () => {
      const { client } = testable(async (id) => ok(testReport(id)), [[source('a', { alias: 'alpha' })], 'fail']);
      render(<Harness client={client} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      await userEvent.setup().click(button());
      const alert = await within(main()).findByRole('alert');
      expect(alert.textContent).toBe('NETWORK_UNAVAILABLE');
      expect(within(screen.getByRole('region', { name: 'alpha health' })).queryByRole('alert')).toBeNull();
      expect(facts()[1]).toEqual(['Connection', 'Neo4j Kernel 5.26.32']);
    });

    it('says not reached, with no failure notice, for a report of a source that did not answer', async () => {
      const failed = testReport('a', { outcome: 'fail', state: 'unavailable', stateReason: 'The source could not be reached.', server: null, versionSupported: null, readOnlyCheck: 'not-verified', loginCanWrite: null, degreeChecks: { status: 'not-run', foundOn: null, types: [], warnings: [] } });
      const { client } = testable(async () => ok(failed), [[source('a', { alias: 'alpha' })], 'pending']);
      render(<Harness client={client} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      await userEvent.setup().click(button());
      await screen.findByText('Test finished: unavailable');
      expect(facts().slice(1, 3)).toEqual([['Connection', 'Not reached'], ['Read-only verified', 'Not verified']]);
      expect(within(screen.getByRole('region', { name: 'alpha health' })).queryByRole('alert')).toBeNull();
    });

    it('keeps the connection of a failed report that had a server', async () => {
      const failed = testReport('a', { outcome: 'fail', state: 'unavailable', stateReason: 'The mapping does not fit the source.' });
      const { client } = testable(async () => ok(failed), [[source('a', { alias: 'alpha' })], 'pending']);
      render(<Harness client={client} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      await userEvent.setup().click(button());
      await screen.findByText('Test finished: unavailable');
      expect(facts()[1]).toEqual(['Connection', 'Neo4j Kernel 5.26.32']);
    });

    it.each([
      [{ code: 'SOURCE_BUSY', message: 'The source is busy.', retryable: true, traceId: 't-1' }, 'SOURCE_BUSY · trace t-1'],
      [{ code: 'QUERY_TIMEOUT', message: 'It took too long.', retryable: true, traceId: 't-2' }, 'QUERY_TIMEOUT · trace t-2'],
      [{ code: 'ACCESS_DENIED', message: 'No access.', retryable: false, traceId: 't-3' }, 'ACCESS_DENIED · trace t-3'],
      [{ code: 'NOT_FOUND', message: 'No such source.', retryable: false, traceId: 't-4' }, 'NOT_FOUND · trace t-4'],
      [{ code: 'NETWORK_UNAVAILABLE' }, 'NETWORK_UNAVAILABLE'],
      [{ code: 'SCHEMA_MISMATCH' }, 'SCHEMA_MISMATCH'],
    ] as const)('shows %j beside the button, keeps the facts shown before and makes the button available again', async (failure, text) => {
      const { client } = testable(async () => ({ ok: false, failure }), [[source('a', { alias: 'alpha', lastTestAt: '2026-10-30T10:16:08.000Z' })]]);
      render(<Harness client={client} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      const before = facts();
      await userEvent.setup().click(button());
      expect((await within(screen.getByRole('region', { name: 'alpha health' })).findByRole('alert')).textContent).toBe(text);
      expect(facts()).toEqual(before);
      expect(button().getAttribute('aria-disabled')).toBe('false');
    });

    it('keeps a run going when another source is selected, keeps its answer for its own source, and leaves the other button free', async () => {
      const run = pendingTest();
      const { client } = testable((id) => (id === 'a' ? run.promise : Promise.resolve(ok(testReport(id)))), [[source('a', { alias: 'alpha' }), source('b', { alias: 'beta' })], 'pending']);
      render(<Harness client={client} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      const user = userEvent.setup();
      await user.click(button());
      await user.click(rowButton(1));
      expect(button().textContent).toBe('Test source');
      run.resolve(ok(testReport('a', { server: { product: 'Neo4j Kernel', version: '5.26.1', edition: 'community' } })));
      await act(async () => undefined);
      expect(facts()[1]).toEqual(['Connection', 'Not tested yet']);
      await user.click(rowButton(0));
      expect(facts()[1]).toEqual(['Connection', 'Neo4j Kernel 5.26.1']);
    });

    it('applies the answer to its source after the person left the page and came back, with no second request', async () => {
      const run = pendingTest();
      const { client, calls } = testable(() => run.promise, [[source('a', { alias: 'alpha' })]]);
      renderApp('/sources', client);
      const user = userEvent.setup();
      await within(main()).findByRole('list', { name: 'Configured sources' });
      await user.click(button());
      await user.click(screen.getByRole('link', { name: 'Home' }));
      await user.click(screen.getByRole('link', { name: 'Sources' }));
      expect(button('Testing…')).toBeTruthy();
      run.resolve(ok(testReport('a')));
      await screen.findByText('Test finished: connected');
      expect(calls.tests).toEqual(['a']);
    });

    it('drops the held report when the sources answer later says the source was not tested with the current configuration', async () => {
      const { client } = testable(async (id) => ok(testReport(id)), [[source('a', { alias: 'alpha' })], [source('a', { alias: 'alpha', lastTestAt: '2026-11-02T10:00:00.000Z', lastTest: null })]]);
      render(<Harness client={client} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      await userEvent.setup().click(button());
      await screen.findByText('Test finished: connected');
      await act(async () => undefined);
      expect(facts().slice(1, 3)).toEqual([['Connection', 'Not tested with the current configuration'], ['Read-only verified', 'Not tested with the current configuration']]);
    });

    it('is reached with Tab after the rows, shows its focus, and keeps focus through a run', async () => {
      const { client } = testable(async (id) => ok(testReport(id)), [[source('a', { alias: 'alpha' }), source('b', { alias: 'beta' })], 'pending']);
      render(<Harness client={client} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      const user = userEvent.setup();
      screen.getByRole('button', { name: 'Read again' }).focus();
      await user.tab();
      expect(document.activeElement).toBe(rowButton(0));
      await user.tab();
      expect(document.activeElement).toBe(rowButton(1));
      await user.tab();
      expect(document.activeElement).toBe(button());
      await user.keyboard('{Enter}');
      await screen.findByText('Test finished: connected');
      expect(document.activeElement).toBe(button());
    });
  });

  describe('the degree warnings', () => {
    const base = {
      checkedAt: '2026-10-30T10:16:08.000Z',
      outcome: 'warn' as const,
      server: { product: 'Neo4j Kernel', version: '5.26.32' },
      versionSupported: true,
      readOnlyCheck: 'privileges-inspected' as const,
      loginCanWrite: false,
    };
    const estimated = 'Degree counts are estimated for thing: no cheap per-type degree index';
    const couldNot = 'Degree counts could not be checked for other: the probe timed out';
    const detail = () => screen.getByRole('region', { name: /health$/ });
    const open = async (lastTest: SourceSummary['lastTest'], extra: Partial<SourceSummary> = {}, client?: ApiClient) => {
      render(<Harness client={client ?? clientWith({ me: me(), sources: [source('a', { alias: 'alpha', lastTest, lastTestAt: lastTest?.checkedAt ?? null, ...extra })] })} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
    };

    it('shows one banner with each warning on its own line, word for word, and hides the icon from a screen reader', async () => {
      await open({ ...base, degreeStatus: 'warn', degreeWarnings: [estimated, couldNot] });
      const items = within(detail()).getAllByRole('listitem');
      expect(items.map((item) => item.textContent)).toEqual([estimated, couldNot]);
      const banner = detail().querySelector('.degree-warning');
      expect(banner?.textContent).toBe(`${estimated}${couldNot}`);
      expect(banner?.querySelector('.icon')?.getAttribute('aria-hidden')).toBe('true');
      expect(within(detail()).queryByText(/exact/i)).toBeNull();
    });

    it('shows no banner and no note when the check passed', async () => {
      await open({ ...base, outcome: 'pass', degreeStatus: 'pass', degreeWarnings: [] });
      expect(detail().querySelector('.degree-warning')).toBeNull();
      expect(within(detail()).queryByText('Degree counts were not checked in this test.')).toBeNull();
    });

    it('says the check was not run, with no banner, for a test that did not run it', async () => {
      await open({ ...base, outcome: 'pass', degreeStatus: 'not-run', degreeWarnings: [] });
      expect(within(detail()).getByText('Degree counts were not checked in this test.')).toBeTruthy();
      expect(detail().querySelector('.degree-warning')).toBeNull();
    });

    it('shows neither for a source with no test', async () => {
      await open(null);
      expect(detail().querySelector('.degree-warning')).toBeNull();
      expect(within(detail()).queryByText('Degree counts were not checked in this test.')).toBeNull();
    });

    it('removes the banner when a later test has no warning, and keeps it when a later test fails', async () => {
      const warned = source('a', { alias: 'alpha', lastTest: { ...base, degreeStatus: 'warn', degreeWarnings: [estimated] }, lastTestAt: base.checkedAt });
      let attempt = 0;
      let reads = 0;
      const first = profiled({
        getMe: async () => ({ ok: true, value: me() }),
        getSources: () => {
          reads += 1;
          return reads === 1 ? Promise.resolve({ ok: true as const, value: { items: [warned], nextCursor: null } }) : new Promise<never>(() => undefined);
        },
        testSource: async (id) => {
          attempt += 1;
          return attempt === 1 ? { ok: false, failure: { code: 'SOURCE_BUSY', message: 'busy', retryable: true, traceId: 't' } } : { ok: true, value: testReport(id, { checkedAt: '2026-11-02T10:00:00.000Z' }) };
        },
      });
      render(<Harness client={first} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      const user = userEvent.setup();
      await user.click(within(detail()).getByRole('button', { name: 'Test source' }));
      await within(detail()).findByRole('alert');
      expect(within(detail()).getByText(estimated)).toBeTruthy();
      await user.click(within(detail()).getByRole('button', { name: 'Test source' }));
      await screen.findByText('Test finished: connected');
      expect(within(detail()).queryByText(estimated)).toBeNull();
    });
  });

  describe('the mapping excerpt', () => {
    const region = () => screen.getByRole('region', { name: 'Mapping example' });
    const profileOf = (sourceId: string, mappingExcerpt: string): ApiResult<SourceProfile> => ({ ok: true, value: { ...testProfile(sourceId), mappingExcerpt } });
    const withExcerpts = (getProfile: ApiClient['getProfile'], sources = [source('a', { alias: 'alpha' }), source('b', { alias: 'beta' })]) => {
      const asked: string[] = [];
      const client = profiled({
        getMe: async () => ({ ok: true, value: me() }),
        getSources: async () => ({ ok: true, value: { items: sources, nextCursor: null } }),
        getProfile: (id, signal) => {
          asked.push(id);
          return getProfile(id, signal);
        },
      });
      return { client, asked };
    };

    it('shows the excerpt word for word in a preformatted block under its heading and label, and reads each source once in a visit', async () => {
      const { client, asked } = withExcerpts(async (id) => profileOf(id, `sources:\n  - id: ${id}\n    entities:\n      - type: thing`));
      render(<Harness client={client} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      expect(await screen.findByRole('heading', { name: 'Mapping example', level: 3 })).toBeTruthy();
      expect(screen.getByText('YAML · read-only · not a query')).toBeTruthy();
      expect(region().tagName).toBe('PRE');
      expect(region().textContent).toBe('sources:\n  - id: a\n    entities:\n      - type: thing');
      const user = userEvent.setup();
      await user.click(rowButton(1));
      await waitFor(() => expect(region().textContent).toContain('id: b'));
      await user.click(rowButton(0));
      expect(region().textContent).toContain('id: a');
      expect(asked).toEqual(['a', 'b']);
    });

    it('reads again when the page is opened again, keeps the earlier text meanwhile and shows the changed text, and keeps the earlier text when that read fails', async () => {
      const second = pendingProfile();
      let reads = 0;
      const { client, asked } = withExcerpts((id) => (++reads === 1 ? Promise.resolve(profileOf(id, 'before')) : reads === 2 ? second.promise : Promise.resolve({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } })), [source('a', { alias: 'alpha' })]);
      renderApp('/sources', client);
      const user = userEvent.setup();
      await waitFor(() => expect(region().textContent).toBe('before'));
      await user.click(screen.getByRole('link', { name: 'Home' }));
      await user.click(screen.getByRole('link', { name: 'Sources' }));
      await waitFor(() => expect(asked).toEqual(['a', 'a']));
      expect(region().textContent).toBe('before');
      second.resolve(profileOf('a', 'after'));
      await waitFor(() => expect(region().textContent).toBe('after'));
      await user.click(screen.getByRole('link', { name: 'Home' }));
      await user.click(screen.getByRole('link', { name: 'Sources' }));
      await waitFor(() => expect(asked).toHaveLength(3));
      expect((await within(screen.getByRole('region', { name: 'alpha health' })).findByRole('alert')).textContent).toBe('NETWORK_UNAVAILABLE');
      expect(region().textContent).toBe('after');
    });

    it('reads again when the page is reached again with Back, which restores the earlier address, and not within one opening', async () => {
      const { client, asked } = withExcerpts(async (id) => profileOf(id, 'text'), [source('a', { alias: 'alpha' })]);
      const { router } = renderApp('/sources', client);
      const user = userEvent.setup();
      await waitFor(() => expect(region().textContent).toBe('text'));
      await user.click(screen.getByRole('link', { name: 'Home' }));
      await act(async () => {
        await router.navigate(-1);
      });
      await waitFor(() => expect(asked).toEqual(['a', 'a']));
      await waitFor(() => expect(region().textContent).toBe('text'));
      expect(asked).toEqual(['a', 'a']);
    });

    it('reads once more when the page is opened again while the first read is still going, and shows the answer of that read', async () => {
      const first = pendingProfile();
      let reads = 0;
      const { client, asked } = withExcerpts((id) => (++reads === 1 ? first.promise : Promise.resolve(profileOf(id, 'newer'))), [source('a', { alias: 'alpha' })]);
      renderApp('/sources', client);
      const user = userEvent.setup();
      await waitFor(() => expect(asked).toEqual(['a']));
      await user.click(screen.getByRole('link', { name: 'Home' }));
      await user.click(screen.getByRole('link', { name: 'Sources' }));
      expect(asked).toEqual(['a']);
      first.resolve(profileOf('a', 'older'));
      await waitFor(() => expect(asked).toEqual(['a', 'a']));
      await waitFor(() => expect(region().textContent).toBe('newer'));
    });

    it('shows the loading text, not the failure of the read that was replaced, when the page is opened again and the first read then fails', async () => {
      const first = pendingProfile();
      const second = pendingProfile();
      let reads = 0;
      const { client, asked } = withExcerpts(() => (++reads === 1 ? first.promise : second.promise), [source('a', { alias: 'alpha' })]);
      renderApp('/sources', client);
      const user = userEvent.setup();
      await waitFor(() => expect(asked).toEqual(['a']));
      await user.click(screen.getByRole('link', { name: 'Home' }));
      await user.click(screen.getByRole('link', { name: 'Sources' }));
      first.resolve({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
      await waitFor(() => expect(asked).toEqual(['a', 'a']));
      const detail = screen.getByRole('region', { name: 'alpha health' });
      expect(await within(detail).findByText('Loading the mapping…')).toBeTruthy();
      expect(within(detail).queryByRole('alert')).toBeNull();
      expect(within(detail).queryByRole('button', { name: 'Try again' })).toBeNull();
      second.resolve(profileOf('a', 'newer'));
      await waitFor(() => expect(region().textContent).toBe('newer'));
    });

    it('shows markup and a link in the excerpt as plain text, with no link or control in the block', async () => {
      const { client } = withExcerpts(async (id) => profileOf(id, '<b>bold</b> https://example.test/a'), [source('a', { alias: 'alpha' })]);
      render(<Harness client={client} />);
      await waitFor(() => expect(region().textContent).toBe('<b>bold</b> https://example.test/a'));
      expect(region().querySelector('b, a, button, input')).toBeNull();
    });

    it('says the mapping is loading while the first read is going, and the rest of the detail stays usable', async () => {
      const { client } = withExcerpts(() => new Promise(() => undefined), [source('a', { alias: 'alpha' })]);
      render(<Harness client={client} />);
      expect(await screen.findByText('Loading the mapping…')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Test source' })).toBeTruthy();
      expect(screen.getAllByRole('term').length).toBe(4);
    });

    it('shows the code and trace ID of a failed first read in place of the block, and Try again reads it again', async () => {
      let reads = 0;
      const { client, asked } = withExcerpts(async (id) => (++reads === 1 ? { ok: false, failure: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', retryable: false, traceId: 'trace-5' } } : profileOf(id, 'now')), [source('a', { alias: 'alpha' })]);
      render(<Harness client={client} />);
      const detail = await screen.findByRole('region', { name: 'alpha health' });
      expect((await within(detail).findByRole('alert')).textContent).toBe('INTERNAL_ERROR · trace trace-5');
      expect(screen.queryByRole('region', { name: 'Mapping example' })).toBeNull();
      expect(within(detail).getByRole('button', { name: 'Test source' }).className).toBe('primary');
      expect(within(detail).getByRole('button', { name: 'Try again' }).className).toBe('secondary');
      await userEvent.setup().click(within(detail).getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(region().textContent).toBe('now'));
      expect(asked).toEqual(['a', 'a']);
    });

    it('treats a profile that names another source as a schema mismatch and never shows it', async () => {
      const { client } = withExcerpts(async () => profileOf('other', 'not mine'), [source('a', { alias: 'alpha' })]);
      render(<Harness client={client} />);
      const detail = await screen.findByRole('region', { name: 'alpha health' });
      expect((await within(detail).findByRole('alert')).textContent).toBe('SCHEMA_MISMATCH');
      expect(screen.queryByText('not mine')).toBeNull();
    });

    it('shows each source only its own excerpt after two quick selections, whichever answer arrives first', async () => {
      const one = pendingProfile();
      const two = pendingProfile();
      const { client } = withExcerpts((id) => (id === 'a' ? one.promise : two.promise));
      render(<Harness client={client} />);
      await within(main()).findByRole('list', { name: 'Configured sources' });
      const user = userEvent.setup();
      await user.click(rowButton(1));
      two.resolve(profileOf('b', 'text of b'));
      await waitFor(() => expect(region().textContent).toBe('text of b'));
      one.resolve(profileOf('a', 'text of a'));
      await act(async () => undefined);
      expect(region().textContent).toBe('text of b');
      await user.click(rowButton(0));
      expect(region().textContent).toBe('text of a');
    });

    it('still shows the excerpt of an unavailable source', async () => {
      const { client } = withExcerpts(async (id) => profileOf(id, 'from the mapping'), [source('a', { alias: 'alpha', state: 'unavailable', stateReason: 'TLS handshake failed' })]);
      render(<Harness client={client} />);
      await waitFor(() => expect(region().textContent).toBe('from the mapping'));
    });

    it('says there is no excerpt for an empty one, and makes a long block focusable, named and scrollable inside itself', async () => {
      const empty = withExcerpts(async (id) => profileOf(id, ''), [source('a', { alias: 'alpha' })]);
      const view = render(<Harness client={empty.client} />);
      expect(await screen.findByText('The mapping has no excerpt to show.')).toBeTruthy();
      view.unmount();
      const long = withExcerpts(async (id) => profileOf(id, `${'key: value '.repeat(200)}\n`.repeat(60)), [source('a', { alias: 'alpha' })]);
      render(<Harness client={long.client} />);
      await waitFor(() => expect(region().textContent?.length).toBeGreaterThan(1000));
      expect(region().tabIndex).toBe(0);
    });
  });

  describe('the diagnostics row', () => {
    it('shows a disabled Diagnostics bundle button, described by "Coming later"', async () => {
      render(<Harness client={profiled({ getMe: async () => ({ ok: true, value: me() }), getSources: async () => ({ ok: true, value: { items: [source('a', { alias: 'alpha' })], nextCursor: null } }) })} />);
      const detail = await screen.findByRole('region', { name: 'alpha health' });
      const bundle = within(detail).getByRole('button', { name: 'Diagnostics bundle' });
      expect(bundle.hasAttribute('disabled')).toBe(true);
      expect(bundle.className).toBe('secondary');
      const noteId = bundle.getAttribute('aria-describedby');
      expect(noteId === null ? null : document.getElementById(noteId)?.textContent).toBe('Coming later');
    });

    it('sends no request when it is activated, and no diagnostics path is ever asked for', async () => {
      const asked: string[] = [];
      const fetcher = createApiClient(async (input) => {
        asked.push(input);
        if (input === '/v1/me') return new Response(JSON.stringify(me()));
        if (input === '/v1/sources') return new Response(JSON.stringify({ items: [source('a', { alias: 'alpha' })], nextCursor: null }));
        if (input.endsWith('/profile')) return new Response(JSON.stringify(testProfile('a')));
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No.', retryable: false, traceId: 't' } }), { status: 404 });
      });
      render(<Harness client={fetcher} />);
      const detail = await screen.findByRole('region', { name: 'alpha health' });
      const user = userEvent.setup();
      await user.click(within(detail).getByRole('button', { name: 'Diagnostics bundle' }));
      await user.click(within(detail).getByRole('button', { name: 'Test source' }));
      await within(detail).findByRole('alert');
      expect(asked.some((path) => path.includes('diagnostics'))).toBe(false);
      expect(asked.filter((path) => path !== '/v1/me' && path !== '/v1/sources' && !path.endsWith('/profile') && !path.endsWith('/test'))).toEqual([]);
    });

    it('is skipped by Tab: the next stop after Test source is not the bundle button', async () => {
      render(<Harness client={profiled({ getMe: async () => ({ ok: true, value: me() }), getSources: async () => ({ ok: true, value: { items: [source('a', { alias: 'alpha' })], nextCursor: null } }) })} />);
      const detail = await screen.findByRole('region', { name: 'alpha health' });
      const user = userEvent.setup();
      within(detail).getByRole('button', { name: 'Test source' }).focus();
      await user.tab();
      expect(document.activeElement).not.toBe(within(detail).getByRole('button', { name: 'Diagnostics bundle' }));
    });
  });
});
