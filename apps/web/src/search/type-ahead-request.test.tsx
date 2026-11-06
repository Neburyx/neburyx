import { act, cleanup, fireEvent, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { key as testKey, node } from '../state/test-data.js';
import { holding, inputOf, panelWorkspace, searchAnswer, setText, settle, sourceBox, TIMEOUT, typeText, TYPEAHEAD_DEBOUNCE_MS, wait } from './panel-test-kit.js';
import { hit } from './search-test-kit.js';
import { lengthOf, useTypeahead } from './use-typeahead.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the text of a type-ahead search', () => {
  it.each([
    ['', 'short'],
    ['a', 'short'],
    ['😀', 'short'],
    ['ab', 'ok'],
    ['😀😀', 'ok'],
    ['a'.repeat(200), 'ok'],
    ['😀'.repeat(200), 'ok'],
    ['a'.repeat(201), 'long'],
    ['😀'.repeat(201), 'long'],
  ])('is %j: %s', (text, length) => {
    expect(lengthOf(text)).toBe(length);
  });
});

describe('the type-ahead request of the Add from source tab', () => {
  it('has a second tab that the arrow keys reach, keeping the focus on the tabs, and whose box takes the focus when the tab is clicked', async () => {
    await panelWorkspace();
    expect(screen.getByRole('tab', { name: 'Add from source' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(sourceBox());
    fireEvent.click(screen.getByRole('tab', { name: /On canvas/ }));
    screen.getByRole('tab', { name: /On canvas/ }).focus();
    fireEvent.keyDown(screen.getByRole('tab', { name: /On canvas/ }), { key: 'ArrowRight' });
    await wait(20);
    expect(screen.getByRole('tab', { name: 'Add from source' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Add from source' }));
  });

  it('says to open an investigation and sends nothing when no investigation is bound', async () => {
    const { searches } = await panelWorkspace({ bound: false });
    expect(screen.getByText('Open an investigation to search its source.')).toBeDefined();
    expect(screen.queryByRole('searchbox', { name: 'Find in the source' })).toBeNull();
    await wait(TYPEAHEAD_DEBOUNCE_MS * 2);
    expect(searches).toEqual([]);
  });

  it('sends one request once the text has stood still for the delay, with the source, the text and the flag, and none for five keys within it', async () => {
    const { searches } = await panelWorkspace();
    await typeText('AC-12');
    await wait(TYPEAHEAD_DEBOUNCE_MS - 10 - 1);
    expect(searches).toEqual([]);
    await wait(1);
    expect(searches).toHaveLength(1);
    expect(searches[0]?.request).toEqual({ sourceId: 'a', text: 'AC-12', typeahead: true });
  });

  it('asks for the mask the session asks for', async () => {
    const { searches } = await panelWorkspace({ mask: true });
    await typeText('AC');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    expect(searches[0]?.request).toEqual({ sourceId: 'a', text: 'AC', typeahead: true, mask: true });
  });

  it.each([['a'], ['😀']])('sends nothing for one character, %s', async (text) => {
    const { searches } = await panelWorkspace();
    await typeText(text);
    await wait(TYPEAHEAD_DEBOUNCE_MS * 2);
    expect(searches).toEqual([]);
    expect(screen.queryByText('Use at most 200 characters.')).toBeNull();
  });

  it('sends the text of 200 characters, and for 201 sends nothing, cancels the request and says so', async () => {
    const { searches } = await panelWorkspace();
    setText('a'.repeat(200));
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    expect(searches).toHaveLength(1);
    setText('a'.repeat(201));
    await wait(TYPEAHEAD_DEBOUNCE_MS * 2);
    expect(searches).toHaveLength(1);
    expect(searches[0]?.signal?.aborted).toBe(true);
    expect(screen.getByText('Use at most 200 characters.')).toBeDefined();
  });

  it('cancels a request in flight when the text becomes too short', async () => {
    const { searches } = await panelWorkspace();
    await typeText('AB');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    expect(searches[0]?.signal?.aborted).toBe(false);
    setText('A');
    expect(searches[0]?.signal?.aborted).toBe(true);
    await wait(TYPEAHEAD_DEBOUNCE_MS * 2);
    expect(searches).toHaveLength(1);
  });

  it('keeps the text out of the address, the history state and the console', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((spy) => spy.mockImplementation(() => undefined));
    const { searches, router } = await panelWorkspace();
    await typeText('needle-text-9042');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    expect(searches).toHaveLength(1);
    const location = router.state.location;
    expect(`${location.pathname}${location.search}${location.hash}${JSON.stringify(location.state)}`).not.toContain('needle');
    expect(spies.flatMap((spy) => spy.mock.calls).flat().join(' ')).not.toContain('needle');
    for (const spy of spies) spy.mockRestore();
  });

  it('drops the text and the request when the mask changes, aborts the request and ignores its late answer', async () => {
    const { searches, state } = await panelWorkspace();
    await typeText('AC');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    expect(searches).toHaveLength(1);
    act(() => state.setMask(true));
    expect(searches[0]?.signal?.aborted).toBe(true);
    expect(inputOf(sourceBox()).value).toBe('');
    searches[0]?.answer({ ok: true, value: searchAnswer('a') });
    await wait(TYPEAHEAD_DEBOUNCE_MS * 2);
    expect(searches).toHaveLength(1);
  });

  it('drops the text and aborts the request when the investigation changes, and again when it changes after the person switched away and back', async () => {
    const { searches, state } = await panelWorkspace();
    await typeText('AC');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    act(() => {
      state.show({ id: 'inv-2', sourceId: 'a', record: { title: 'Another', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
    });
    expect(searches[0]?.signal?.aborted).toBe(true);
    expect(inputOf(sourceBox()).value).toBe('');
    await typeText('XY');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    expect(searches).toHaveLength(2);
    act(() => {
      state.show({ id: 'inv-3', sourceId: 'a', record: { title: 'Third', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
    });
    expect(searches[1]?.signal?.aborted).toBe(true);
    act(() => void state.resume('inv-2', false));
    expect(inputOf(sourceBox()).value).toBe('');
    searches[1]?.answer({ ok: true, value: searchAnswer('a') });
    await wait(TYPEAHEAD_DEBOUNCE_MS * 2);
    expect(searches).toHaveLength(2);
  });

  it('drops the text and aborts the request when the investigation changes away and back inside one batch of updates', async () => {
    const { searches, state } = await panelWorkspace({ bound: false });
    const opened = { ...testKey('a'), params: 'open:inv-a' };
    const inv = (id: string) => ({ id, sourceId: 'a', record: { title: id, caseRef: null, save: { kind: 'unsaved' as const } }, resultKeys: [opened], nodeRefs: [node('a', 'ACC-1').ref], edgeRefs: [] });
    const results = [{ key: opened, result: { sourceId: 'a', nodes: [node('a', 'ACC-1')], edges: [] } }];
    act(() => void state.show(inv('inv-a'), results));
    await typeText('AC');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    act(() => {
      state.show({ ...inv('inv-b'), resultKeys: [], nodeRefs: [] }, []);
      state.show(inv('inv-a'), results);
    });
    expect(searches[0]?.signal?.aborted).toBe(true);
    expect(inputOf(sourceBox()).value).toBe('');
    searches[0]?.answer({ ok: true, value: searchAnswer('a', [hit('a', 'ACC-1')]) });
    await wait(TYPEAHEAD_DEBOUNCE_MS * 2);
    expect(screen.queryByText('Title ACC-1')).toBeNull();
  });

  it('shows a failure, stops waiting and sends again on Retry when the client rejects', async () => {
    const { client, searches } = await panelWorkspace();
    const spy = vi.spyOn(client, 'searchEntities').mockRejectedValueOnce(new Error('the network went away'));
    await typeText('AC');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('UNEXPECTED_FAILURE');
    expect(screen.queryByText('Searching…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await wait(0);
    expect(searches).toHaveLength(1);
    spy.mockRestore();
  });

  it('aborts the request and the wait when the panel is closed, and starts fresh when it is opened again', async () => {
    const { searches } = await panelWorkspace();
    await typeText('AC');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Close Search' }));
    expect(searches[0]?.signal?.aborted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await wait(TYPEAHEAD_DEBOUNCE_MS * 2);
    expect(searches).toHaveLength(1);
  });
});

describe('the answers of the type-ahead hook', () => {
  function rendered(client: ApiClient, text: string, sourceId = 'a', mask = false) {
    return renderHook((props: { readonly text: string; readonly sourceId: string; readonly mask: boolean }) => useTypeahead(client, props.sourceId, props.mask, props.text), { initialProps: { text, sourceId, mask } });
  }

  it('aborts the older request when the text changes, and never shows an older answer over a newer one', async () => {
    const { client, searches } = holding();
    const hook = rendered(client, 'AC');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    hook.rerender({ text: 'ACC', sourceId: 'a', mask: false });
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    expect(searches).toHaveLength(2);
    expect(searches[0]?.signal?.aborted).toBe(true);
    searches[1]?.answer({ ok: true, value: searchAnswer('a', [hit('a', 'ACC-1')]) });
    await settle();
    searches[0]?.answer({ ok: true, value: searchAnswer('a') });
    await settle();
    expect(hook.result.current.answered?.text).toBe('ACC');
    expect(hook.result.current.answered?.result.exact).toHaveLength(1);
  });

  it('keeps the earlier answer while a newer search waits and runs, and keeps it too when the newer one fails, with the failure beside it', async () => {
    const { client, searches } = holding();
    const hook = rendered(client, 'AC');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    searches[0]?.answer({ ok: true, value: searchAnswer('a', [node('a', 'ACC-1')]) });
    await settle();
    hook.rerender({ text: 'ACC', sourceId: 'a', mask: false });
    expect(hook.result.current.waiting).toBe(true);
    expect(hook.result.current.answered?.text).toBe('AC');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    searches[1]?.answer({ ok: false, failure: TIMEOUT });
    await settle();
    expect(hook.result.current.answered?.text).toBe('AC');
    expect(hook.result.current.failure).toMatchObject({ code: 'QUERY_TIMEOUT' });
    expect(hook.result.current.waiting).toBe(false);
  });

  it('does nothing on a retry while the text is too short, and does not let it skip the delay of the next text', async () => {
    const { client, searches } = holding();
    const hook = rendered(client, 'A');
    act(() => hook.result.current.retry());
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    expect(searches).toEqual([]);
    hook.rerender({ text: 'AB', sourceId: 'a', mask: false });
    await wait(TYPEAHEAD_DEBOUNCE_MS - 1);
    expect(searches).toEqual([]);
    await wait(1);
    expect(searches).toHaveLength(1);
  });

  it('sends the same search again at once on a retry', async () => {
    const { client, searches } = holding();
    const hook = rendered(client, 'AC');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    searches[0]?.answer({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    await settle();
    act(() => hook.result.current.retry());
    await wait(0);
    expect(searches).toHaveLength(2);
    expect(searches[1]?.request).toEqual(searches[0]?.request);
  });
});
