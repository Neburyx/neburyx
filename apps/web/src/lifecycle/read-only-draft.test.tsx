import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { DraftWriteRequest } from '@neburyx/contracts';
import { MemoryRouter } from 'react-router';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { AUTOSAVE_DELAY_MS, createDraftSync, type DraftSync } from '../draft/draft-sync.js';
import type { ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { elementKey } from '../state/keys.js';
import { ref } from '../state/test-data.js';
import { InvestigationIdentity } from '../workspace/investigation-identity.js';
import { SlotsProvider, createSlotRegistry } from '../workspace/slots.js';
import { failure, ID, investigationOf, shownState } from './harness.js';

class FakePage {
  readonly handlers = new Map<string, Set<(event: Event) => void>>();
  visibilityState = 'visible';
  addEventListener(type: string, listener: (event: Event) => void): void {
    this.handlers.set(type, (this.handlers.get(type) ?? new Set()).add(listener));
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.handlers.get(type)?.delete(listener);
  }
  fire(type: string): Event {
    const event = new Event(type, { cancelable: true });
    for (const listener of [...(this.handlers.get(type) ?? [])]) listener(event);
    return event;
  }
}

interface Write {
  readonly version: number;
  readonly body: DraftWriteRequest;
}

function rig(status: 'open' | 'closed' | 'archived', answer: (call: number) => ApiResult<{ version: number; save: { state: 'unsaved'; savedAt: null }; notes: null }> = (call) => ({ ok: true, value: { version: call + 1, save: { state: 'unsaved', savedAt: null }, notes: null } })) {
  const state: ClientState = shownState(status);
  const writes: Write[] = [];
  const page = new FakePage();
  const reads = vi.fn(async () => ({ ok: true as const, value: { investigation: investigationOf('closed', 8), draft: { version: 1, layout: { schemaVersion: 1 as const, layout: 'force', nodes: [], edges: [], groups: [] }, queryContext: { schemaVersion: 1 as const, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } }, notes: null } } }));
  const client = fakeClient({
    saveDraft: async (_id, version, body) => {
      writes.push({ version, body });
      return answer(writes.length);
    },
    getInvestigation: reads,
  });
  const sync: DraftSync = createDraftSync({ client, state, page, document: page });
  sync.adopt(ID, { version: 1, notes: null, writable: true });
  render(
    <MemoryRouter>
      <ClientStateProvider state={state}>
        <SlotsProvider registry={createSlotRegistry()}>
          <InvestigationIdentity />
        </SlotsProvider>
      </ClientStateProvider>
    </MemoryRouter>,
  );
  const move = (x = 1): void => act(() => state.presentation.setPosition(elementKey(ref('demo', 'type-a', 'A')), { x, y: 0 }));
  const reopen = (): void =>
    act(() => {
      const held = state.investigation.getState().record;
      if (held !== null) state.describeInvestigation({ ...held, status: 'open', readOnly: false, version: held.version + 1 });
    });
  const pillText = (): string | undefined => screen.getAllByRole('status')[0]?.textContent ?? undefined;
  return { state, sync, writes, page, move, reopen, pillText, reads };
}

beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-11-10T10:00:00.000Z') }));
afterEach(() => vi.useRealTimers());

describe('the draft of a closed or archived investigation', () => {
  it.each(['closed', 'archived'] as const)('sends no write for %s however the canvas changes', async (status) => {
    const { writes, move, sync } = rig(status);
    move(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 4);
    move(2);
    sync.flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 4);
    expect(writes).toHaveLength(0);
  });

  it('keeps the pill plain and asks nothing on leaving while the canvas equals the draft', () => {
    const { pillText, page } = rig('closed');
    expect(pillText()).toBe('Closed · read-only');
    expect(page.fire('beforeunload').defaultPrevented).toBe(false);
  });

  it.each([
    ['closed', 'Closed · read-only · changes not saved'],
    ['archived', 'Archived · read-only · changes not saved'],
  ] as const)('adds "changes not saved" to the %s pill once the canvas differs, and asks before the page is left', (status, text) => {
    const { pillText, page, move } = rig(status);
    move(1);
    expect(pillText()).toBe(text);
    expect(page.fire('beforeunload').defaultPrevented).toBe(true);
  });

  it('does not hold the person at a page they leave for changes that cannot be saved', async () => {
    const { sync, move } = rig('closed');
    move(1);
    expect(sync.needsSettle()).toBe(false);
    await expect(sync.settle()).resolves.toBe(true);
  });

  it('writes the changes made while closed once, with the current draft version, within the autosave delay after a reopen, and then the pill and the warning go', async () => {
    const { writes, move, reopen, pillText, page } = rig('closed');
    move(7);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(writes).toHaveLength(0);
    reopen();
    expect(pillText()).toBe('Unsaved');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.version).toBe(1);
    expect(writes[0]?.body.layout.nodes[0]).toMatchObject({ x: 7, y: 0 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(writes).toHaveLength(1);
    expect(page.fire('beforeunload').defaultPrevented).toBe(false);
  });

  it('sends nothing after a reopen when the canvas still equals the draft', async () => {
    const { writes, reopen } = rig('closed');
    reopen();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(writes).toHaveLength(0);
  });
});

describe('an investigation closed in another tab', () => {
  it('stops writing and shows the pill from the refusal alone when the investigation cannot be read again', async () => {
    const { writes, move, state, reads, pillText } = rig('open', () => ({ ok: false, failure: failure('CONFLICT', 'This investigation is closed or archived. Reopen it to make changes.', { reason: 'investigation-read-only', status: 'archived' }) }));
    reads.mockImplementation((async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } })) as never);
    move(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(state.investigation.getState().record).toMatchObject({ status: 'archived', readOnly: true });
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 5);
    expect(writes).toHaveLength(1);
    expect(pillText()).toBe('Archived · read-only · changes not saved');
  });

  it('reads the investigation again when a write answers the read-only conflict, shows its status, and stops writing', async () => {
    const { writes, move, state, reads, pillText } = rig('open', () => ({ ok: false, failure: failure('CONFLICT', 'This investigation is closed or archived. Reopen it to make changes.', { reason: 'investigation-read-only', status: 'closed' }) }));
    move(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes).toHaveLength(1);
    expect(reads).toHaveBeenCalledWith(ID);
    expect(state.investigation.getState().record).toMatchObject({ status: 'closed', readOnly: true, version: 8 });
    expect(pillText()).toBe('Closed · read-only · changes not saved');
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 5);
    expect(writes).toHaveLength(1);
  });
});
