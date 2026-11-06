import { act, configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf } from '../investigations/test-data.js';
import { renderApp } from '../test-utils.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };

const sourceLine = (): string | null => document.querySelector('section[aria-label="Source"]')?.textContent ?? null;
const addressOf = (view: { router: { state: { location: { pathname: string } } } }): string => view.router.state.location.pathname;

async function openRow(title: string): Promise<void> {
  await userEvent.setup().click(await screen.findByRole('link', { name: title }));
}

describe('opening a row of the Recent list', () => {
  it('goes to the investigation by its ID, sends no open, reads the investigation and its starting entity in its own source, and names that source', async () => {
    const parts = knowing([A, B]);
    const view = renderApp('/', parts.client);
    await openRow('kind-a A-1');
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(addressOf(view)).toBe(`/explore/${INVESTIGATION_A}`);
    expect(parts.calls.openInvestigation).toEqual([]);
    expect(new Set(parts.calls.getInvestigation)).toEqual(new Set([INVESTIGATION_A]));
    expect(parts.calls.getEntity.length).toBeGreaterThan(0);
    expect(sourceLine()).toContain('Source source-a');
  });

  it('opens an investigation with no case reference as that investigation and creates no other', async () => {
    const parts = knowing([A, B]);
    const view = renderApp('/', parts.client);
    await openRow('kind-a C-1');
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    expect(addressOf(view)).toBe(`/explore/${INVESTIGATION_B}`);
    expect(parts.calls.openInvestigation).toEqual([]);
    expect(sourceLine()).toContain('Source source-b');
  });

  it('opens a row of the second source in that source and brings the first back as it was, with no new read', async () => {
    const parts = knowing([A, B]);
    const view = renderApp('/', parts.client, createClientState());
    await openRow('kind-a A-1');
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await act(async () => view.router.navigate(-1));
    await openRow('kind-a C-1');
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    expect(sourceLine()).toContain('Source source-b');
    await act(async () => view.router.navigate(-1));
    const reads = { entity: parts.calls.getEntity.length, investigation: parts.calls.getInvestigation.length };
    await openRow('kind-a A-1');
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(sourceLine()).toContain('Source source-a');
    expect(parts.calls.getEntity).toHaveLength(reads.entity);
    expect(parts.calls.getInvestigation).toHaveLength(reads.investigation);
  });
});

describe('a row that cannot be opened', () => {
  const returnsHome = async (view: ReturnType<typeof renderApp>) => {
    await act(async () => view.router.navigate(-1));
    expect(await screen.findByRole('link', { name: 'kind-a A-1' })).toBeTruthy();
    expect(document.querySelectorAll('.recent-row')).toHaveLength(2);
  };

  it('shows the not-found page for an investigation the API no longer has, and Back returns to Home with its rows', async () => {
    const parts = knowing([A, B], { getInvestigation: async () => ({ ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-1' } }) });
    const view = renderApp('/', parts.client);
    await openRow('kind-a A-1');
    expect(await screen.findByRole('heading', { name: 'Investigation not found', level: 1 })).toBeTruthy();
    await returnsHome(view);
  });

  it('shows the page for a source that is not available as it was, and Back returns to Home with its rows', async () => {
    const gone = { ...A, investigation: { ...A.investigation, sourceState: 'removed' as const } };
    const parts = knowing([gone, B]);
    const view = renderApp('/', parts.client);
    await openRow('kind-a A-1');
    expect(await screen.findByRole('heading', { level: 1, name: /not available as it was/ })).toBeTruthy();
    await returnsHome(view);
  });

  it('shows the failure of the entity read with Try again, and Back returns to Home with its rows', async () => {
    const parts = knowing([A, B], { getEntity: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    const view = renderApp('/', parts.client);
    await openRow('kind-a A-1');
    const notice = await screen.findByRole('group', { name: 'Opening failed' });
    expect(notice.textContent).toContain('NETWORK_UNAVAILABLE');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy());
    await returnsHome(view);
  });
});
