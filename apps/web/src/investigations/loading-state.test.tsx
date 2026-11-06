import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import type { GraphNode } from '@neburyx/contracts';
import { createClientState } from '../state/client-state.js';
import { renderApp } from '../test-utils.js';
import { BACK_TO_HOME, NOT_FOUND_TITLE, SOURCE_NOT_AVAILABLE_TITLE, TRY_AGAIN } from './messages.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf } from './test-data.js';

const INVESTIGATION_C = '0192f000-0000-7000-8000-0000000000c1';
const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };
const C = { investigation: investigationOf(INVESTIGATION_C, 'source-b', 'kind-a', 'D-1'), node: nodeOf('source-b', 'kind-a', 'D-1') };

const strip = (): string | null => document.querySelector('.status-strip')?.textContent ?? null;
const busy = (): string | null => document.querySelector('main.canvas-region')?.getAttribute('aria-busy') ?? null;
const title = (): string | null => document.querySelector('h1')?.textContent ?? null;
const go = (view: { router: { navigate: (to: string) => Promise<void> } }, to: string) => act(async () => view.router.navigate(to));

type Reading = (stableId: string) => Promise<void>;

function held(): { readonly wait: Reading; readonly release: (stableId: string) => void } {
  const waiting = new Map<string, () => void>();
  return {
    wait: (stableId) => new Promise<void>((resolve) => waiting.set(stableId, resolve)),
    release: (stableId) => waiting.get(stableId)?.(),
  };
}

function slowFor(gate: ReturnType<typeof held>, stableIds: readonly string[]) {
  return {
    getEntity: async (ref: { sourceId: string; entityType: string; stableId: string }): Promise<ApiResult<GraphNode>> => {
      if (stableIds.includes(ref.stableId)) await gate.wait(ref.stableId);
      return { ok: true, value: nodeOf(ref.sourceId, ref.entityType, ref.stableId) };
    },
  };
}

async function onFirst(known = [A, B, C], overrides = {}) {
  const parts = knowing(known, overrides);
  const state = createClientState();
  const view = renderApp(`/explore/${INVESTIGATION_A}`, parts.client, state);
  await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
  return { ...parts, state, view };
}

let stop: () => void = () => undefined;
afterEach(() => stop());

describe('an investigation that is being opened while another is on screen', () => {
  it('is marked as opening, says the graph shown is still the previous one by its title, and shows nothing of the new one before it is read', async () => {
    const gate = held();
    const { view, state } = await onFirst(undefined, slowFor(gate, ['C-1']));
    const shown = state.investigation.getState();
    await go(view, `/explore/${INVESTIGATION_B}`);
    expect(strip()).toContain('Opening the investigation');
    expect(strip()).toContain('still “kind-a A-1”');
    expect(document.querySelector('.status-strip [role="status"]')).not.toBeNull();
    expect(busy()).toBe('true');
    expect(title()).toBe('kind-a A-1');
    expect(document.body.textContent).not.toContain('kind-a C-1');
    expect(document.querySelector('section[aria-label="Source"]')?.textContent).toContain('Source source-a');
    expect(state.investigation.getState()).toBe(shown);
  });

  it('shows no render of the new address with the previous graph unmarked', async () => {
    const gate = held();
    const { view } = await onFirst(undefined, slowFor(gate, ['C-1']));
    const snapshots: { title: string | null; strip: string | null; busy: string | null }[] = [];
    const observer = new MutationObserver(() => snapshots.push({ title: title(), strip: strip(), busy: busy() }));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    stop = () => observer.disconnect();
    await go(view, `/explore/${INVESTIGATION_B}`);
    expect(snapshots.length).toBeGreaterThan(0);
    for (const shot of snapshots) {
      expect(shot.title).toBe('kind-a A-1');
      expect(shot.strip ?? '').toContain('Opening the investigation');
      expect(shot.busy).toBe('true');
    }
    await act(async () => {
      gate.release('C-1');
      await Promise.resolve();
    });
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
  });

  it('changes the title, the source and the graph together when the read succeeds, and the marking goes', async () => {
    const gate = held();
    const { view } = await onFirst(undefined, slowFor(gate, ['C-1']));
    await go(view, `/explore/${INVESTIGATION_B}`);
    await act(async () => {
      gate.release('C-1');
      await Promise.resolve();
    });
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    expect(strip()).toBeNull();
    expect(busy()).not.toBe('true');
    expect(document.querySelector('section[aria-label="Source"]')?.textContent).toContain('Source source-b');
  });

  it('ends the marking when the read fails in a way that can be tried again, shows the failure with Try again, and keeps the previous investigation', async () => {
    let up = false;
    const { view, state } = await onFirst(undefined, { getEntity: async (ref: { sourceId: string; entityType: string; stableId: string }) => (ref.stableId === 'A-1' || up ? { ok: true, value: nodeOf(ref.sourceId, ref.entityType, ref.stableId) } : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    const shown = state.investigation.getState();
    await go(view, `/explore/${INVESTIGATION_B}`);
    expect((await screen.findByRole('group', { name: 'Opening failed' })).textContent).toContain('NETWORK_UNAVAILABLE');
    expect(strip()).toBeNull();
    expect(busy()).not.toBe('true');
    expect(title()).toBe('kind-a A-1');
    expect(state.investigation.getState()).toBe(shown);
    up = true;
    await userEvent.setup().click(screen.getByRole('button', { name: TRY_AGAIN }));
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
  });

  it('is replaced by the page for an investigation that is not found, or whose source is not available as it was, with nothing marked as loading', async () => {
    const gone = { ...B, investigation: { ...B.investigation, sourceState: 'removed' as const } };
    const { view } = await onFirst([A, gone]);
    await go(view, '/explore/0192f000-0000-7000-8000-0000000000ee');
    await screen.findByRole('heading', { name: NOT_FOUND_TITLE, level: 1 });
    expect(strip()).toBeNull();
    expect(busy()).not.toBe('true');
    expect(screen.getByRole('link', { name: BACK_TO_HOME })).toBeTruthy();
    await go(view, `/explore/${INVESTIGATION_B}`);
    await screen.findByRole('heading', { name: SOURCE_NOT_AVAILABLE_TITLE, level: 1 });
    expect(strip()).toBeNull();
    expect(busy()).not.toBe('true');
  });

  it('shows the destination when the person moves on, and an abandoned open that answers late leaves no failure and no mark on the newer open, whichever answers first', async () => {
    const gate = held();
    const { view, state } = await onFirst(undefined, slowFor(gate, ['C-1', 'D-1']));
    await go(view, `/explore/${INVESTIGATION_B}`);
    await go(view, `/explore/${INVESTIGATION_C}`);
    expect(strip()).toContain('still “kind-a A-1”');
    await act(async () => {
      gate.release('C-1');
      await Promise.resolve();
    });
    expect(strip()).toContain('Opening the investigation');
    expect(busy()).toBe('true');
    expect(title()).toBe('kind-a A-1');
    expect(screen.queryByRole('group', { name: 'Opening failed' })).toBeNull();
    expect(state.investigation.getState().id).toBe(INVESTIGATION_A);
    await act(async () => {
      gate.release('D-1');
      await Promise.resolve();
    });
    await screen.findByRole('heading', { name: 'kind-a D-1', level: 1 });
    expect(strip()).toBeNull();
    expect(busy()).not.toBe('true');
    expect(screen.queryByRole('group', { name: 'Opening failed' })).toBeNull();
    expect(state.investigation.getState().id).toBe(INVESTIGATION_C);
  });

  it('shows the newer open when it answered first, and the abandoned one that answers after it changes nothing', async () => {
    const gate = held();
    const { view, state } = await onFirst(undefined, slowFor(gate, ['C-1']));
    await go(view, `/explore/${INVESTIGATION_B}`);
    await go(view, `/explore/${INVESTIGATION_C}`);
    await screen.findByRole('heading', { name: 'kind-a D-1', level: 1 });
    await act(async () => {
      gate.release('C-1');
      await Promise.resolve();
    });
    expect(title()).toBe('kind-a D-1');
    expect(strip()).toBeNull();
    expect(busy()).not.toBe('true');
    expect(screen.queryByRole('group', { name: 'Opening failed' })).toBeNull();
    expect(state.investigation.getState().id).toBe(INVESTIGATION_C);
    await go(view, `/explore/${INVESTIGATION_A}`);
    await go(view, '/sources');
    await screen.findByRole('heading', { name: 'Sources', level: 1 });
    expect(document.querySelector('.status-strip')).toBeNull();
  });

  it('shows the opening line alone, and no title or graph, when nothing was on screen', async () => {
    const gate = held();
    const { client } = knowing([A], slowFor(gate, ['A-1']));
    renderApp(`/explore/${INVESTIGATION_A}`, client, createClientState());
    await screen.findByText('Opening the investigation…');
    expect(strip()).toBe('Opening the investigation…');
    expect(title()).toBeNull();
    expect(busy()).toBe('true');
    expect(screen.getByText('0 entities · 0 relationships · loaded · exact')).toBeTruthy();
  });

  it('shows an investigation the session holds at once, with no marking and no read', async () => {
    const { view, calls } = await onFirst();
    await go(view, `/explore/${INVESTIGATION_B}`);
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    const reads = JSON.stringify(calls);
    const watched: (string | null)[] = [];
    const observer = new MutationObserver(() => watched.push(strip()));
    observer.observe(document.body, { childList: true, subtree: true });
    stop = () => observer.disconnect();
    await go(view, `/explore/${INVESTIGATION_A}`);
    expect(title()).toBe('kind-a A-1');
    expect(watched.every((text) => text === null)).toBe(true);
    expect(busy()).not.toBe('true');
    expect(JSON.stringify(calls)).toBe(reads);
  });
});
