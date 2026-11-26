import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantThreadResponse } from '@neburyx/contracts';
import { READ_WAIT_MS } from '../api/read-wait.js';
import { drawn, end, ENDINGS, expectBlock, held, press, timesSaid } from '../waiting-kit.js';
import { createPanelRegistry } from '../workspace/panel-registry.js';
import { installFakeBroadcastChannel } from '../windows/fake-broadcast.js';
import { forgetOpenedWindows } from '../windows/pop-out.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { harness, REFUSE } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

let restore: () => void = () => undefined;
let unbind: () => void = () => undefined;
beforeEach(() => {
  vi.useFakeTimers();
  restore = installFakeBroadcastChannel();
});
afterEach(() => {
  cleanup();
  unbind();
  unbind = () => undefined;
  forgetOpenedWindows();
  restore();
  vi.useRealTimers();
});

const SENTENCE = ASSISTANT_COPY.storedLoading;
const thread: AssistantThreadResponse = { turns: [{ id: '0192f000-0000-7000-8000-0000000000a1', seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'answered', intent: 'shared-devices', citedElements: 3, steps: 1 }], earlierTurns: 0, previousThreadClearedAt: null, epoch: 0 };

async function open() {
  const reads = held<AssistantThreadResponse>();
  const h = harness(async () => ({ ok: true, value: REFUSE }), 1000, (_id, signal) => reads.read(signal));
  unbind = bindAssistantPanel(h.state, createPanelRegistry(), h.session);
  render(h.tree());
  await drawn();
  return reads;
}

const body = () => document.querySelector('.assistant-body') as HTMLElement;

describe('the stored Assistant thread while it is read', () => {
  it.each(ENDINGS)('says so once over hidden skeleton turns, and stops on: %s', async (how) => {
    const reads = await open();
    const waiting = () => {
      const block = expectBlock(SENTENCE, body());
      expect(block.querySelectorAll('.skeleton-turn')).toHaveLength(2);
      expect(timesSaid(SENTENCE)).toBe(1);
    };
    waiting();
    await end(how, reads.calls[0], thread, READ_WAIT_MS, waiting);
    expect(timesSaid(SENTENCE)).toBe(0);
    expect(body().querySelector('.loading-block, .loading-shape, [aria-busy="true"]')).toBeNull();
    if (how === 'answer') expect(document.querySelectorAll('.assistant-stored-row')).toHaveLength(1);
    else expect(screen.getByText(ASSISTANT_COPY.storedFailed)).toBeTruthy();
  });

  it('draws the wait again for the read of Try again', async () => {
    const reads = await open();
    await end('failure', reads.calls[0], thread, READ_WAIT_MS, () => undefined);
    await press(screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain }));
    expectBlock(SENTENCE, body());
    expect(reads.calls).toHaveLength(2);
  });
});
