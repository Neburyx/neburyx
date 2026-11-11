import { act, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { renderApp, source } from '../test-utils.js';
import { pagedClient, rowsOf, viewsOf } from './page-fixtures.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const bodyRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.investigations-table tbody tr')];
const status = (): string => document.querySelector('.investigations-status')?.textContent ?? '';

/**
 * Each archives 25 rows one after another through the real menu. That takes about 0.3 s here and about 19 times that on the CI runner, which is past the default 5 s, so these two tests state a longer limit.
 * It is a limit and not a wait: they end as soon as the last step does.
 */
const MANY_ARCHIVES_MS = 20_000;

async function openPage(client: ApiClient, path = '/investigations') {
  const view = renderApp(path, client);
  return view;
}

/**
 * Archives the row of a case from its actions menu and waits for its link to leave. The queries are by label and text, not by role: a role query walks the accessibility tree of a table of 25 rows, and
 * 25 rounds of three of them made these tests cost most of their time (and several times that on a slow runner). The tests that use it also set the delay of `userEvent` to none, which skips a timer
 * between the steps of a click.
 */
async function archiveCase(user: ReturnType<typeof userEvent.setup>, index: number) {
  // the link is there before the archive, so that the wait for it to leave is a wait for something
  expect(screen.getByText(`Case ${index}`, { selector: 'a' })).toBeTruthy();
  await user.click(screen.getByLabelText(`Actions for Case ${index}`));
  await user.click(within(screen.getByRole('menu')).getByText('Archive'));
  await waitFor(() => expect(screen.queryByText(`Case ${index}`, { selector: 'a' })).toBeNull());
}

describe('the Investigations page: the table', () => {
  it('shows the heading, the three tabs, the columns and the first 25 of the open investigations', async () => {
    const { client } = pagedClient(rowsOf(60), []);
    await openPage(client);
    await screen.findByRole('link', { name: 'Case 1' });
    expect(screen.getByRole('heading', { name: 'Investigations', level: 1 })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Investigations (60)', 'Saved views (0)', 'Evidence packsEvidence packs, Enterprise only']);
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Title and referral', 'Starting entity', 'Source', 'Last edited (UTC)', 'Entities / relationships (loaded)', 'Actions']);
    expect(bodyRows()).toHaveLength(25);
    expect(status()).toBe('Showing 25 of 60');
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBeNull();
    expect(screen.getByRole('table', { name: 'Your investigations, most recently edited first' })).toBeTruthy();
  });

  it('reaches every one of 60 rows with Show more, moves the focus to the first new title link and removes the button at the end', async () => {
    const { client, recorded } = pagedClient(rowsOf(60), []);
    await openPage(client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(50));
    expect(status()).toBe('Showing 50 of 60');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Case 26' }));
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(60));
    expect(status()).toBe('Showing 60 of 60');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(recorded.pages.map((query) => query.cursor).filter((cursor) => cursor !== undefined)).toEqual(['25', '50']);
  });

  it('opens the investigation from its title link, shows the UTC time and the referral, and the counts as entities and relationships', async () => {
    const { client } = pagedClient(rowsOf(2, (index) => (index === 0 ? { caseRef: 'REF-0042', nodeCount: 10, edgeCount: 13 } : {})), []);
    await openPage(client);
    const link = await screen.findByRole('link', { name: 'Case 1' });
    expect(link.getAttribute('href')).toBe('/explore/0192f000-0000-7000-8000-000000000001');
    const row = bodyRows()[0];
    expect(row?.textContent).toContain('5 Nov 2026 12:00');
    expect(row?.textContent).toContain('Case reference');
    expect(row?.textContent).toContain('REF-0042');
    expect(row?.textContent).toContain('10 / 13');
  });

  it('shows an empty cell named "Counts not available" when the counts are null', async () => {
    const { client } = pagedClient(rowsOf(1, () => ({ nodeCount: null, edgeCount: null })), []);
    await openPage(client);
    await screen.findByRole('link', { name: 'Case 1' });
    expect(bodyRows()[0]?.textContent).toContain('Counts not available');
    expect(bodyRows()[0]?.textContent).not.toContain('/');
  });

  it('shows a failed first read with a retry, and the rows when it works', async () => {
    const parts = pagedClient(rowsOf(3));
    let failing = true;
    const first = parts.client.listInvestigationPage;
    const client: ApiClient = { ...parts.client, listInvestigationPage: async (query, signal) => (failing ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : first(query, signal)) };
    await openPage(client);
    const user = userEvent.setup();
    await screen.findByText('The investigations could not be read.');
    expect(screen.queryByRole('table')).toBeNull();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('link', { name: 'Case 1' });
    expect(screen.queryByText('The investigations could not be read.')).toBeNull();
  });

  it('keeps the rows when Show more fails and offers the retry, which reads the same page', async () => {
    const parts = pagedClient(rowsOf(60));
    let more = 0;
    const read = parts.client.listInvestigationPage;
    const client: ApiClient = { ...parts.client, listInvestigationPage: async (query, signal) => (query.cursor !== undefined && ++more === 1 ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : read(query, signal)) };
    await openPage(client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await screen.findByText('The next investigations could not be read.');
    expect(bodyRows()).toHaveLength(25);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(50));
  });

  it('says there are no investigations and links to Home when there are none', async () => {
    const { client } = pagedClient([]);
    await openPage(client);
    expect(await screen.findByText(/No investigations yet\. Open one from Home\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Home' }).getAttribute('href')).toBe('/');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('marks the table busy while the first page is read, and sends one request for two presses of Show more', async () => {
    const parts = pagedClient(rowsOf(60));
    let release: () => void = () => undefined;
    const read = parts.client.listInvestigationPage;
    let slow = false;
    let moreAsked = 0;
    const client: ApiClient = {
      ...parts.client,
      listInvestigationPage: async (query, signal) => {
        if (slow && query.cursor !== undefined) {
          moreAsked += 1;
          await new Promise<void>((resolve) => (release = resolve));
        }
        return read(query, signal);
      },
    };
    await openPage(client);
    await screen.findByRole('link', { name: 'Case 1' });
    slow = true;
    const more = screen.getByRole('button', { name: 'Show more' });
    await act(async () => {
      more.click();
      more.click();
    });
    expect(moreAsked).toBe(1);
    await act(async () => release());
    await waitFor(() => expect(bodyRows()).toHaveLength(50));
  });

  it('reads no source for the rows themselves: only the list and, after the rows are drawn, the labels', async () => {
    const { client, recorded } = pagedClient(rowsOf(4));
    await openPage(client);
    await screen.findByRole('link', { name: 'Case 1' });
    expect(recorded.pages.every((query) => query.cursor === undefined)).toBe(true);
  });
});

describe('the Investigations page: the starting-entity labels', () => {
  it('reads the labels with one call for each source of the page, after the rows are drawn, and shows each', async () => {
    const { client, recorded } = pagedClient(rowsOf(4));
    await openPage(client);
    await screen.findByRole('link', { name: 'Case 1' });
    await waitFor(() => expect(bodyRows()[0]?.textContent).toContain('Label E-1'));
    expect(recorded.readRefs.slice().sort((a, b) => a.sourceId.localeCompare(b.sourceId))).toEqual([
      { sourceId: 'source-a', refs: 2 },
      { sourceId: 'source-b', refs: 2 },
    ]);
  });

  it('shows the masked label the server gives, and the stored reference is not shown as a label', async () => {
    const parts = pagedClient(rowsOf(1));
    const client: ApiClient = { ...parts.client, readRefs: async (request) => ({ ok: true, value: { nodes: request.entities.map((ref) => ({ ref, display: { title: 'J••• L•••', type: ref.entityType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } })), edges: [], missing: { entities: [], edges: [] } } }) };
    await openPage(client);
    await waitFor(() => expect(bodyRows()[0]?.textContent).toContain('J••• L•••'));
    expect(bodyRows()[0]?.textContent).not.toContain('E-1');
  });

  it('keeps the entity type name when a reference is not found, a read fails, or the source is busy or rate limited', async () => {
    for (const failure of [{ code: 'SOURCE_UNAVAILABLE', message: 'busy', retryable: true, traceId: 't' }, { code: 'RATE_LIMITED', message: 'slow down', retryable: true, traceId: 't' }, { code: 'NETWORK_UNAVAILABLE' }] as const) {
      const parts = pagedClient(rowsOf(1));
      const client: ApiClient = { ...parts.client, readRefs: async () => ({ ok: false, failure }) };
      const view = await openPage(client);
      await screen.findByRole('link', { name: 'Case 1' });
      await waitFor(() => expect(parts.recorded.pages.length).toBeGreaterThan(0));
      expect(bodyRows()[0]?.textContent?.toLowerCase()).toContain('kind-a');
      view.unmount();
    }
    const missing = pagedClient(rowsOf(1), [], { readRefs: async () => ({ ok: true, value: { nodes: [], edges: [], missing: { entities: [], edges: [] } } }) });
    await openPage(missing.client);
    await screen.findByRole('link', { name: 'Case 1' });
    expect(bodyRows()[0]?.textContent?.toLowerCase()).toContain('kind-a');
    expect(bodyRows()[0]?.textContent).not.toContain('Label');
  });

  it('makes no read for a row with a source that is removed or re-pointed, and reads only the new rows after Show more', async () => {
    const rows = rowsOf(30, (index) => (index === 0 ? { sourceState: 'removed' as const } : index === 1 ? { sourceState: 'repointed' as const } : {}));
    const { client, recorded } = pagedClient(rows);
    await openPage(client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await waitFor(() => expect(recorded.readRefs.length).toBeGreaterThan(0));
    expect(recorded.readRefs.reduce((sum, call) => sum + call.refs, 0)).toBe(23);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(30));
    await waitFor(() => expect(recorded.readRefs.reduce((sum, call) => sum + call.refs, 0)).toBe(28));
  });

  it('shows the pill "Source re-pointed" or "Source removed" next to the title of a row whose source changed, in the accessible name of its row, and no pill for the others', async () => {
    const rows = rowsOf(4, (index) => (index === 0 ? { sourceState: 'removed' as const } : index === 1 ? { sourceState: 'repointed' as const } : {}));
    const { client, recorded } = pagedClient(rows);
    await openPage(client);
    await screen.findByRole('link', { name: 'Case 1' });
    const pillsOf = (row: HTMLElement | undefined): (string | null)[] => [...(row?.querySelectorAll('.badge') ?? [])].map((badge) => badge.textContent);
    expect(pillsOf(bodyRows()[0])).toEqual(['Source removed']);
    expect(pillsOf(bodyRows()[1])).toEqual(['Source re-pointed']);
    expect(pillsOf(bodyRows()[2])).toEqual([]);
    expect(screen.getByRole('row', { name: /Case 1.*Source removed/ })).toBeTruthy();
    expect(screen.getByRole('row', { name: /Case 2.*Source re-pointed/ })).toBeTruthy();
    await waitFor(() => expect(recorded.readRefs.length).toBeGreaterThan(0));
    expect(recorded.readRefs.reduce((sum, call) => sum + call.refs, 0)).toBe(2);
    expect(screen.getByRole('link', { name: 'Case 1' }).getAttribute('href')).toMatch(/^\/explore\//);
    expect(within(bodyRows()[0] as HTMLElement).getByRole('link', { name: 'Case 1' })).toBeTruthy();
    expect(screen.getAllByText('Source removed')).toHaveLength(1);
    expect(screen.queryByText('Source no longer available as it was')).toBeNull();
  });

  it('drops a label answer that comes after the filters changed and asks again when the row is shown again', async () => {
    const parts = pagedClient(rowsOf(2));
    const releases: (() => void)[] = [];
    let held = true;
    const read = parts.client.readRefs;
    const client: ApiClient = {
      ...parts.client,
      readRefs: async (request, signal) => {
        if (held) await new Promise<void>((resolve) => releases.push(resolve));
        return read(request, signal);
      },
    };
    await openPage(client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await user.type(screen.getByLabelText('Title or referral'), 'case 2{Enter}');
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    held = false;
    await act(async () => releases.forEach((release) => release()));
    await user.clear(screen.getByLabelText('Title or referral'));
    await user.type(screen.getByLabelText('Title or referral'), 'case{Enter}');
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    await waitFor(() => expect(bodyRows()[0]?.textContent).toContain('Label E-1'));
    expect(parts.recorded.readRefs.length).toBeGreaterThan(1);
  });

  it('gives a row that is in both lists its label when the old answer comes after the new list', async () => {
    const parts = pagedClient(rowsOf(2));
    const releases: (() => void)[] = [];
    let held = true;
    const read = parts.client.readRefs;
    const client: ApiClient = {
      ...parts.client,
      readRefs: async (request, signal) => {
        if (held) await new Promise<void>((resolve) => releases.push(resolve));
        return read(request, signal);
      },
    };
    await openPage(client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await user.type(screen.getByLabelText('Title or referral'), 'case 1{Enter}');
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    held = false;
    await act(async () => releases.forEach((release) => release()));
    await waitFor(() => expect(bodyRows()[0]?.textContent).toContain('Label E-1'));
  });

  it('moves no focus and announces nothing as the labels arrive', async () => {
    const { client } = pagedClient(rowsOf(4));
    await openPage(client);
    const link = await screen.findByRole('link', { name: 'Case 2' });
    link.focus();
    await waitFor(() => expect(bodyRows()[0]?.textContent).toContain('Label E-1'));
    expect(document.activeElement).toBe(link);
    expect(document.querySelector('.investigations-entity-label[aria-live], .investigations-entity [role="status"]')).toBeNull();
    expect(status()).toBe('Showing 4 of 4');
  });
});

describe('the Investigations page: the filters', () => {
  it('offers Open by default with Closed and Archived, All sources with the configured sources, and a text box', async () => {
    const { client } = pagedClient(rowsOf(3));
    await openPage(client);
    await screen.findByRole('link', { name: 'Case 1' });
    expect(within(screen.getByRole('combobox', { name: 'Status' })).getAllByRole('option').map((option) => option.textContent)).toEqual(['Open', 'Closed', 'Archived']);
    expect(within(screen.getByRole('combobox', { name: 'Source' })).getAllByRole('option').map((option) => option.textContent)).toEqual(['All sources', 'Source source-a', 'Source source-b']);
    expect(screen.getByLabelText('Title or referral')).toBeTruthy();
    expect(screen.getByText('Archived investigations are hidden. Deleted ones stay restorable for 30 days.')).toBeTruthy();
  });

  it('finds a case reference fragment, drops the cursor, follows the exact count and keeps the filters in the address', async () => {
    const rows = rowsOf(60, (index) => (index === 41 ? { caseRef: 'REF-2026-0042' } : {}));
    const { client, recorded } = pagedClient(rows);
    const view = await openPage(client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await user.type(screen.getByLabelText('Title or referral'), '26-004');
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(bodyRows()[0]?.textContent).toContain('Case 42');
    expect(status()).toBe('Showing 1 of 1');
    expect(screen.getAllByRole('tab')[0]?.textContent).toBe('Investigations (1)');
    expect(recorded.pages.at(-1)).toEqual({ status: 'open', text: '26-004' });
    expect(view.router.state.location.search).toBe('?q=26-004');
  });

  it('sends nothing for one character and says so, tied to the box', async () => {
    const { client, recorded } = pagedClient(rowsOf(3));
    await openPage(client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    const box = screen.getByLabelText('Title or referral');
    await user.type(box, 'c');
    expect(await screen.findByText('Type at least 2 characters.')).toBeTruthy();
    expect(box.getAttribute('aria-describedby')).toBe(screen.getByText('Type at least 2 characters.').id);
    const before = recorded.pages.length;
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(recorded.pages).toHaveLength(before);
    expect(recorded.pages.every((query) => query.text === undefined)).toBe(true);
  });

  it('applies the text on Enter at once, and clears it with Esc', async () => {
    const { client, recorded } = pagedClient(rowsOf(5));
    await openPage(client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    const box = screen.getByLabelText('Title or referral');
    await user.type(box, 'case 3{Enter}');
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(bodyRows()).toHaveLength(5));
    if (!(box instanceof HTMLInputElement)) throw new Error('the box is not an input');
    expect(box.value).toBe('');
    expect(recorded.pages.at(-1)).toEqual({ status: 'open' });
  });

  it('shows closed rows for Status Closed and hides the archived line, and filters by source', async () => {
    const rows = rowsOf(6, (index) => (index < 2 ? { status: 'closed' as const } : {}));
    const { client } = pagedClient(rows);
    await openPage(client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 3' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'closed');
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(screen.queryByText(/Archived investigations are hidden/)).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'open');
    await waitFor(() => expect(bodyRows()).toHaveLength(4));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Source' }), 'source-a');
    await waitFor(() => expect(bodyRows().every((row) => row.textContent?.includes('Source source-a'))).toBe(true));
  });

  it('says no investigation matches and clears the filters', async () => {
    const { client } = pagedClient(rowsOf(3));
    await openPage(client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    await user.type(screen.getByLabelText('Title or referral'), 'zzzz{Enter}');
    expect(await screen.findByText(/No investigations match these filters\./)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
  });

  it('keeps the rows and shows the failure with a retry when a filtered read fails, and ignores an answer that comes late for earlier filters', async () => {
    const parts = pagedClient(rowsOf(5));
    const read = parts.client.listInvestigationPage;
    const slow: { release: () => void } = { release: () => undefined };
    const client: ApiClient = {
      ...parts.client,
      listInvestigationPage: async (query, signal) => {
        if (query.text === 'case 1') return { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };
        if (query.text === 'case 2') await new Promise<void>((resolve) => (slow.release = resolve));
        return read(query, signal);
      },
    };
    await openPage(client);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Case 1' });
    const box = screen.getByLabelText('Title or referral');
    await user.type(box, 'case 1{Enter}');
    await screen.findByText('The investigations could not be read.');
    expect(bodyRows()).toHaveLength(5);
    await user.clear(box);
    await user.type(box, 'case 2{Enter}');
    await user.clear(box);
    await user.type(box, 'case 4{Enter}');
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    await act(async () => slow.release());
    expect(bodyRows()[0]?.textContent).toContain('Case 4');
  });

  it('draws the filter bar as one group that can take another chip', async () => {
    const { client } = pagedClient(rowsOf(1));
    await openPage(client);
    await screen.findByRole('link', { name: 'Case 1' });
    expect(screen.getByRole('group', { name: 'Filter investigations' })).toBeTruthy();
  });
});

describe('the Investigations page: the heading and a list that runs out of shown rows', () => {
  it('names the source in the heading with one source configured and none with several', async () => {
    const one = pagedClient(rowsOf(1), [], { getSources: async () => ({ ok: true, value: { items: [source('source-a')], nextCursor: null } }) });
    const first = await openPage(one.client);
    await screen.findByRole('link', { name: 'Case 1' });
    expect(document.querySelector('.page-heading .source-note')?.textContent).toContain('Source source-a · read-only');
    first.unmount();
    await openPage(pagedClient(rowsOf(1)).client);
    await screen.findByRole('link', { name: 'Case 1' });
    expect(document.querySelector('.page-heading .source-note')).toBeNull();
  });

  it('reads the first page again, and not an empty state, when every shown row has left while more remain', async () => {
    const { client, recorded } = pagedClient(rowsOf(30));
    await openPage(client);
    const user = userEvent.setup({ delay: null });
    await screen.findByRole('link', { name: 'Case 1' });
    for (let index = 1; index <= 25; index += 1) {
      await archiveCase(user, index);
    }
    expect(screen.queryByText(/No investigations/)).toBeNull();
    await waitFor(() => expect(recorded.pages.filter((query) => query.cursor === undefined).length).toBeGreaterThan(1));
  }, MANY_ARCHIVES_MS);

  it('shows the failure with a retry, and sends no more than one request, when the reload after the last row left fails', async () => {
    const parts = pagedClient(rowsOf(30));
    let failing = false;
    let firsts = 0;
    const read = parts.client.listInvestigationPage;
    const client: ApiClient = {
      ...parts.client,
      listInvestigationPage: async (query, signal) => {
        if (query.cursor === undefined) firsts += 1;
        return failing && query.cursor === undefined ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : read(query, signal);
      },
    };
    await openPage(client);
    const user = userEvent.setup({ delay: null });
    await screen.findByRole('link', { name: 'Case 1' });
    for (let index = 1; index <= 24; index += 1) {
      await archiveCase(user, index);
    }
    failing = true;
    const before = firsts;
    await user.click(screen.getByLabelText('Actions for Case 25'));
    await user.click(within(screen.getByRole('menu')).getByText('Archive'));
    await screen.findByText('The investigations could not be read.');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(firsts - before).toBe(1);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  }, MANY_ARCHIVES_MS);
});

