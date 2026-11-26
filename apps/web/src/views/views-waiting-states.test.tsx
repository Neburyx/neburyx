import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewListResponse } from '@neburyx/contracts';
import { READ_WAIT_MS } from '../api/read-wait.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { drawn, end, ENDINGS, expectLine, held, press, timesSaid } from '../waiting-kit.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { createSlotRegistry } from '../workspace/slots.js';
import { INVESTIGATION_ID, namedView, rig, viewsServer } from './view-fixtures.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const WORD = 'Reading again…';
const panel = () => screen.getByRole('dialog', { name: /^Views/ });

/** The Views menu opened, closed and opened again, with the second read of the list still out. */
async function reread() {
  const server = viewsServer([namedView(2, { name: 'Second' }), namedView(1, { name: 'First' })]);
  const reads = held<ViewListResponse>();
  let first: ViewListResponse | undefined;
  let count = 0;
  const parts = rig({
    base: clientWith({ me: me(), sources: [source('demo', { alias: 'fincrime' })] }),
    listViews: async (id, page, signal) => {
      if (++count > 1) return reads.read(signal);
      const result = await server.listViews(id, page, signal);
      if (result.ok) first = result.value;
      return result;
    },
  });
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  renderApp(`/explore/${INVESTIGATION_ID}`, parts.client, parts.state, slots);
  await drawn();
  const control = () => screen.getByRole('button', { name: /^Views/ });
  await press(control());
  expect(timesSaid(WORD)).toBe(0);
  await press(control());
  await press(control());
  if (first === undefined) throw new Error('no first answer');
  return { reads, first };
}

describe('the Views menu while the list is read again', () => {
  it.each(ENDINGS)('keeps the rows usable under one line in a busy panel, and stops on: %s', async (how) => {
    const { reads, first } = await reread();
    const waiting = () => {
      const line = expectLine(WORD, panel());
      expect(line.closest('[aria-busy="true"]')).not.toBeNull();
      expect(within(panel()).getAllByRole('listitem')).toHaveLength(2);
      for (const button of within(within(panel()).getByRole('list')).getAllByRole('button', { name: /^(Rename|Delete)/ })) expect((button as HTMLButtonElement).disabled).toBe(false);
    };
    waiting();
    await end(how, reads.calls[0], first, READ_WAIT_MS, waiting);
    expect(timesSaid(WORD)).toBe(0);
    expect(panel().querySelector('[aria-busy="true"]')).toBeNull();
    if (how === 'answer') expect(within(panel()).getAllByRole('listitem')).toHaveLength(2);
    else expect(within(panel()).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
