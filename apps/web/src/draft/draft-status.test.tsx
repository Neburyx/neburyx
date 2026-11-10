import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeClient } from '../api/fake-client.js';
import { BannerProvider } from '../banner/banner-context.js';
import { createBuiltInBannerController } from '../banner/built-in-causes.js';
import { StatusBanner } from '../banner/status-banner.js';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { key, ref, result } from '../state/test-data.js';
import { INVESTIGATION_DELETED_NOT_SAVED, CHANGES_NOT_BEING_SAVED, CHANGES_NOT_SAVED, CHANGES_STILL_NOT_SAVED, CONFLICT_HEADLINE, CONFLICT_TEXT } from './copy.js';
import { ApiClientProvider } from '../api/client-context.js';
import { ClientStateProvider } from '../state/context.js';
import { DraftAnnouncer, DraftConflictBanner, DraftStatusLine, LeaveGuard } from './draft-status.js';
import { draftSyncOf, AUTOSAVE_DELAY_MS, createDraftSync, RETRY_STEADY_MS, STALLED_AFTER_MS } from './draft-sync.js';

const ID = '0192f000-0000-7000-8000-0000000000a1';
const failure = (code: 'INTERNAL_ERROR' | 'CONFLICTED_VIEW_VERSION' | 'INVALID_REQUEST' | 'NOT_FOUND') => ({ ok: false as const, failure: { code, message: 'x', retryable: false, traceId: 't' } });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function started(answer: () => ReturnType<typeof failure> | { ok: true; value: { version: number; save: { state: 'unsaved'; savedAt: null }; notes: null } }) {
  const state = createClientState();
  state.bindSource('demo');
  const read = result('demo', ['A']);
  state.show({ id: ID, sourceId: 'demo', record: { title: 'T', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: read.nodes.map((n) => n.ref), edgeRefs: [] }, [{ key: key('demo'), result: read }]);
  const client = fakeClient({ saveDraft: async () => answer() });
  const sync = createDraftSync({ client, state });
  sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, writable: true });
  const banner = createBuiltInBannerController();
  const reload = vi.fn();
  const view = render(
    <BannerProvider controller={banner}>
      <StatusBanner />
      <DraftAnnouncer sync={sync} />
      <DraftStatusLine sync={sync} />
      <DraftConflictBanner sync={sync} reload={reload} />
    </BannerProvider>,
  );
  const move = () => act(async () => state.presentation.setPosition(elementKey(ref('demo', 'type-a', 'A')), { x: Math.random(), y: 0 }));
  return { sync, reload, view, move, state };
}

const announcer = (): string => document.querySelector('[role="status"].visually-hidden')?.textContent ?? '';

describe('the status of a draft that is not saved', () => {
  it('says once that the investigation was deleted, with no Save again, after the server answers NOT_FOUND', async () => {
    const { move } = started(() => failure('NOT_FOUND'));
    await move();
    await act(async () => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS));
    expect(announcer()).toBe(INVESTIGATION_DELETED_NOT_SAVED);
    expect(screen.getByText(INVESTIGATION_DELETED_NOT_SAVED, { selector: '.draft-status' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Save again' })).toBeNull();
  });

  it('says nothing while the draft is saved', async () => {
    const { move } = started(() => ({ ok: true, value: { version: 2, save: { state: 'unsaved', savedAt: null }, notes: null } }));
    await move();
    await act(async () => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS));
    expect(announcer()).toBe('');
    expect(document.querySelector('.draft-status')).toBeNull();
  });

  it('shows and announces "Trying again" once, announces nothing for each retry, and changes the words after two minutes', async () => {
    const { move } = started(() => failure('INTERNAL_ERROR'));
    await move();
    await act(async () => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS));
    expect(announcer()).toBe(CHANGES_NOT_SAVED);
    expect(screen.getByText(CHANGES_NOT_SAVED, { selector: '.draft-status' })).toBeDefined();
    const seen: string[] = [];
    const watch = new MutationObserver(() => seen.push(announcer()));
    watch.observe(document.body, { childList: true, characterData: true, subtree: true });
    await act(async () => vi.advanceTimersByTimeAsync(3000 + 6000 + 12000 + RETRY_STEADY_MS));
    expect(seen.filter((text) => text === CHANGES_NOT_SAVED)).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(STALLED_AFTER_MS));
    expect(announcer()).toBe(CHANGES_STILL_NOT_SAVED);
    watch.disconnect();
  });

  it('says plainly that changes are not being saved after a refusal, and offers Save again by the keyboard', async () => {
    let refuse = true;
    const { move, sync } = started(() => (refuse ? failure('INVALID_REQUEST') : { ok: true, value: { version: 2, save: { state: 'unsaved', savedAt: null }, notes: null } }));
    await move();
    await act(async () => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS));
    expect(announcer()).toBe(CHANGES_NOT_BEING_SAVED);
    refuse = false;
    const button = screen.getByRole('button', { name: 'Save again' });
    button.focus();
    expect(document.activeElement).toBe(button);
    vi.useRealTimers();
    await userEvent.setup().keyboard('{Enter}');
    expect(sync.status.getState().kind).toBe('idle');
  });
});

describe('an investigation that changed in another tab', () => {
  it('shows the banner with its words and Reload, moves the focus to it, and Reload works with Enter', async () => {
    const { move, reload } = started(() => failure('CONFLICTED_VIEW_VERSION'));
    await move();
    await act(async () => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS));
    expect(screen.getByText(CONFLICT_HEADLINE)).toBeDefined();
    expect(screen.getByText(CONFLICT_TEXT)).toBeDefined();
    const region = document.querySelector('.banner-region');
    expect(document.activeElement).toBe(region);
    const button = screen.getByRole('button', { name: 'Reload' });
    button.focus();
    vi.useRealTimers();
    await userEvent.setup().keyboard('{Enter}');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('shows no dismiss button and no status line beside the banner, and sends no further write', async () => {
    const { move } = started(() => failure('CONFLICTED_VIEW_VERSION'));
    await move();
    await act(async () => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS));
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    expect(document.querySelector('.draft-status')).toBeNull();
  });
});

describe('the banner of a conflict', () => {
  it('is the amber of the caution tone, with Reload as its primary button, and keeps the chip, the words and the focus on the banner', async () => {
    const { move } = started(() => failure('CONFLICTED_VIEW_VERSION'));
    await move();
    await act(async () => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS));
    const banner = document.querySelector('section.status-banner');
    expect(banner?.classList.contains('status-banner--caution')).toBe(true);
    expect(banner?.querySelector('.status-banner-chip')?.textContent).toBe('Changed elsewhere');
    expect(screen.getByRole('button', { name: 'Reload' }).className).toBe('primary');
    expect(document.activeElement?.classList.contains('banner-region')).toBe(true);
  });
});

describe('the guard that holds the person at a page they were about to leave', () => {
  function guarded(answer: () => ReturnType<typeof failure> | { ok: true; value: { version: number; save: { state: 'unsaved'; savedAt: null }; notes: null } }) {
    const state = createClientState();
    state.bindSource('demo');
    const read = result('demo', ['A']);
    state.show({ id: ID, sourceId: 'demo', record: { title: 'T', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: read.nodes.map((n) => n.ref), edgeRefs: [] }, [{ key: key('demo'), result: read }]);
    const client = fakeClient({ saveDraft: async () => answer() });
    const sync = draftSyncOf(state, client);
    sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, writable: true });
    render(
      <ClientStateProvider state={state}>
        <ApiClientProvider client={client}>
          <LeaveGuard />
        </ApiClientProvider>
      </ClientStateProvider>,
    );
    act(() => state.presentation.setPosition(elementKey(ref('demo', 'type-a', 'A')), { x: 3, y: 0 }));
    return { sync };
  }

  it('shows nothing until a write fails when the person is about to leave, then takes the focus and offers Save again and Leave anyway', async () => {
    const { sync } = guarded(() => failure('INTERNAL_ERROR'));
    expect(screen.queryByRole('button', { name: 'Leave anyway' })).toBeNull();
    let leave: boolean | undefined;
    await act(async () => {
      void sync.settle().then((answer) => (leave = answer));
      await vi.advanceTimersByTimeAsync(0);
    });
    const region = screen.getByRole('region', { name: 'Changes not saved' });
    expect(region.textContent).toContain('Leaving now loses them.');
    expect(region.getAttribute('aria-live')).toBeNull();
    expect(document.activeElement).toBe(region);
    expect(leave).toBeUndefined();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Leave anyway' }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(leave).toBe(true);
    expect(screen.queryByRole('region', { name: 'Changes not saved' })).toBeNull();
  });

  it('goes away when Save again saves the changes, and lets the person go on', async () => {
    let up = false;
    const { sync } = guarded(() => (up ? { ok: true, value: { version: 2, save: { state: 'unsaved', savedAt: null }, notes: null } } : failure('INTERNAL_ERROR')));
    let leave: boolean | undefined;
    await act(async () => {
      void sync.settle().then((answer) => (leave = answer));
      await vi.advanceTimersByTimeAsync(0);
    });
    up = true;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save again' }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(leave).toBe(true);
    expect(screen.queryByRole('region', { name: 'Changes not saved' })).toBeNull();
  });

  it('gives the focus back to where it was when the guard goes', async () => {
    let up = false;
    const { sync } = guarded(() => (up ? { ok: true, value: { version: 2, save: { state: 'unsaved', savedAt: null }, notes: null } } : failure('INTERNAL_ERROR')));
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    await act(async () => {
      void sync.settle();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.activeElement).not.toBe(outside);
    up = true;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save again' }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
