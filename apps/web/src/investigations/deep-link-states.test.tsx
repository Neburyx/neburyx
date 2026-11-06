import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ApiFailure } from '../api/client.js';
import { createClientState } from '../state/client-state.js';
import { renderApp, source } from '../test-utils.js';
import { deepLinkPath } from './deep-link.js';
import { BACK_TO_HOME, LINK_MALFORMED_TITLE, LINK_NOT_FOUND_TEXT, LINK_NOT_FOUND_TITLE, LINK_UNKNOWN_TYPE_TITLE, SOURCE_NOT_AVAILABLE_TITLE, TRY_AGAIN } from './messages.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf, openedOf } from './test-data.js';

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const failure = (code: ApiFailure['code']): { ok: false; failure: ApiFailure } => ({ ok: false, failure: { code, message: 'x', retryable: false, traceId: 'tr-1' } as ApiFailure });
const link = (sourceId: string, stableId: string, entityType = 'kind-a') => deepLinkPath({ sourceId, entityType, stableId });
const sourceLine = () => document.querySelector('section[aria-label="Source"]')?.textContent ?? '';
const headingNote = () => document.querySelector('.page-heading .source-note')?.textContent ?? null;
const answering = (code: ApiFailure['code'] | undefined, overrides = {}) => knowing([A], { openInvestigation: async () => (code === undefined ? { ok: true, value: openedOf(A.investigation, A.node) } : failure(code)), ...overrides });

describe('a link that is not a link', () => {
  it('shows its own page, names no source, sends nothing and offers Home, with the heading first and focused', async () => {
    let sent = 0;
    const { client } = answering(undefined, { openInvestigation: async () => void (sent += 1) });
    renderApp('/source-a/entity/kind-a/~?x=1', client);
    const heading = await screen.findByRole('heading', { name: LINK_MALFORMED_TITLE, level: 1 });
    expect(document.activeElement).toBe(heading);
    expect(headingNote()).toBeNull();
    expect(screen.queryByText('Synthetic data')).toBeNull();
    expect(screen.getByRole('link', { name: BACK_TO_HOME }).getAttribute('href')).toBe('/');
    expect(sent).toBe(0);
  });
});

describe('a link to nothing the person can read', () => {
  it('shows the same heading and words for a source that is not configured, a source the person may not read and an entity the source does not hold, naming no source and with no badge', async () => {
    const shown: string[] = [];
    for (const target of ['nowhere', 'source-b', 'source-a']) {
      const { client } = answering('NOT_FOUND');
      const view = renderApp(link(target, 'A-9'), client);
      const heading = await screen.findByRole('heading', { name: LINK_NOT_FOUND_TITLE, level: 1 });
      expect(document.activeElement).toBe(heading);
      expect(screen.getByText(LINK_NOT_FOUND_TEXT)).toBeTruthy();
      expect(headingNote()).toBeNull();
      expect(screen.queryByText('Synthetic data')).toBeNull();
      shown.push(document.querySelector('main')?.textContent ?? '');
      view.unmount();
    }
    expect(new Set(shown).size).toBe(1);
  });
});

describe('a link to an entity type the readable source does not name', () => {
  it('shows its own page naming the source by alias, or by its ID when it is not listed', async () => {
    const { client } = answering('INVALID_REQUEST');
    renderApp(link('source-a', 'A-1', 'nothing'), client);
    await screen.findByRole('heading', { name: LINK_UNKNOWN_TYPE_TITLE, level: 1 });
    expect(screen.getByText('Source source-a has no entity type of the name this link gives.')).toBeTruthy();
    expect(headingNote()).toBeNull();
    const unlisted = answering('INVALID_REQUEST', { getSources: async () => ({ ok: true, value: { items: [source('source-z')], nextCursor: null } }) });
    renderApp(link('source-a', 'A-1', 'nothing'), unlisted.client);
    expect(await screen.findByText('source-a has no entity type of the name this link gives.')).toBeTruthy();
  });
});

describe('a link whose case reference reuses an investigation of a source that now points elsewhere', () => {
  it('shows the page of an unavailable source with the investigation’s own source ID in the heading, and reads nothing', async () => {
    const { client, calls } = knowing([A], { openInvestigation: async () => ({ ok: true, value: openedOf({ ...A.investigation, sourceState: 'repointed' }, undefined, false) }) });
    renderApp(link('source-a', 'A-1'), client);
    await screen.findByRole('heading', { name: SOURCE_NOT_AVAILABLE_TITLE, level: 1 });
    expect(headingNote()).toBe('source-a');
    expect(screen.queryByText('Synthetic data')).toBeNull();
    expect(calls.getEntity).toEqual([]);
  });
});

describe('a failure that can be tried again', () => {
  it('shows the failure with its heading focused, names the source tried and repeats the same open on Try again, with the investigation that was on screen held and its source named', async () => {
    let up = false;
    const bodies: string[] = [];
    const { client } = knowing([A], {
      openInvestigation: async (body) => {
        bodies.push(JSON.stringify(body));
        return up ? { ok: true, value: openedOf(A.investigation, A.node) } : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };
      },
    });
    const state = createClientState();
    const key = { sourceId: 'source-b', principalId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', policyVersion: 'community', filterHash: 'none', params: 'open:held', mask: false };
    const held = nodeOf('source-b', 'kind-a', 'C-1');
    state.show({ id: INVESTIGATION_B, sourceId: 'source-b', record: { title: 'kind-a C-1', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [key], nodeRefs: [held.ref], edgeRefs: [] }, [{ key, result: { sourceId: 'source-b', nodes: [held], edges: [] } }]);
    const shown = state.investigation.getState();
    const view = renderApp('/sources', client, state);
    await screen.findByRole('heading', { name: 'Sources', level: 1 });
    await act(async () => view.router.navigate(link('source-a', 'A-1')));
    const notice = await screen.findByRole('group', { name: 'Opening failed' });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'The link could not be opened', level: 1 }));
    expect(state.investigation.getState()).toBe(shown);
    expect(state.holds(INVESTIGATION_B, false)).toBe(true);
    expect(sourceLine()).toContain('Source source-b');
    expect(notice.textContent).toContain('NETWORK_UNAVAILABLE');
    expect(notice.textContent).toContain('Could not open in Source source-a.');
    expect(screen.getByRole('link', { name: BACK_TO_HOME })).toBeTruthy();
    expect(screen.getByRole('button', { name: TRY_AGAIN }).className).toBe('secondary');
    up = true;
    await userEvent.setup().click(screen.getByRole('button', { name: TRY_AGAIN }));
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });
});

describe('the status line on these pages', () => {
  it('names the source of the investigation on screen, and with none on screen the only source or the summary of the sources', async () => {
    const first = knowing([A], { openInvestigation: async () => failure('NOT_FOUND'), getSources: async () => ({ ok: true, value: { items: [source('source-a'), source('source-b')], nextCursor: null } }) });
    const one = renderApp(link('source-b', 'X'), first.client);
    await screen.findByRole('heading', { name: LINK_NOT_FOUND_TITLE, level: 1 });
    expect(sourceLine()).toContain('2 sources');
    one.unmount();
    const only = knowing([A], { openInvestigation: async () => failure('NOT_FOUND'), getSources: async () => ({ ok: true, value: { items: [source('source-a')], nextCursor: null } }) });
    const two = renderApp(link('nowhere', 'X'), only.client);
    await screen.findByRole('heading', { name: LINK_NOT_FOUND_TITLE, level: 1 });
    expect(sourceLine()).toContain('Source source-a');
    two.unmount();
    const state = createClientState();
    const on = knowing([A], { openInvestigation: async () => failure('NOT_FOUND') });
    const view = renderApp(link('source-a', 'A-1'), on.client, state);
    await screen.findByRole('heading', { name: LINK_NOT_FOUND_TITLE, level: 1 });
    state.show({ id: INVESTIGATION_A, sourceId: 'source-a', record: { title: 'kind-a A-1', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
    await act(async () => view.router.navigate(link('source-b', 'Y')));
    await screen.findByRole('heading', { name: LINK_NOT_FOUND_TITLE, level: 1 });
    expect(sourceLine()).toContain('Source source-a');
  });
});

describe('the keyboard on these pages', () => {
  it('reaches the link to Home and Try again in reading order, with the heading focused first', async () => {
    const { client } = answering(undefined, { openInvestigation: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    renderApp(link('source-a', 'A-1'), client);
    const retry = await screen.findByRole('button', { name: TRY_AGAIN });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    const home = screen.getByRole('link', { name: BACK_TO_HOME });
    const user = userEvent.setup();
    const reached: Element[] = [];
    for (let presses = 0; presses < 40 && !(reached.includes(retry) && reached.includes(home)); presses += 1) {
      await user.tab();
      if (document.activeElement !== null) reached.push(document.activeElement);
    }
    expect(reached.indexOf(retry)).toBeGreaterThanOrEqual(0);
    expect(reached.indexOf(home)).toBeGreaterThan(reached.indexOf(retry));
  });
});
