import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import { fakeClient } from './api/fake-client.js';
import { openPaths, pathsWorkspace } from './paths/paths-kit.js';
import { StartChoice } from './patterns/run/start-choice.js';
import { held } from './waiting-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const failed = { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } as const;

const WAYS = [
  ['a press', async (user: ReturnType<typeof userEvent.setup>, button: HTMLElement) => user.click(button)],
  [
    'Tab and Enter',
    async (user: ReturnType<typeof userEvent.setup>, button: HTMLElement) => {
      await user.tab();
      expect(document.activeElement).toBe(button);
      await user.keyboard('{Enter}');
    },
  ],
] as const;

describe.each(WAYS)('Try again of a picker reached by %s', (_way, take) => {
  async function searchesAgain(reads: ReturnType<typeof held<SearchResult>>, input: () => HTMLInputElement): Promise<void> {
    const user = userEvent.setup();
    await user.type(input(), 'far');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    await act(async () => reads.calls.at(-1)?.settle(failed));
    const before = reads.calls.length;
    await take(user, screen.getByRole('button', { name: 'Try again to search the source' }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(reads.calls.length).toBe(before + 1);
    expect(input().value).toBe('far');
  }

  it('searches the same text again from the paths panel', async () => {
    const reads = held<SearchResult>();
    await pathsWorkspace({ search: (_request, signal) => reads.read(signal) });
    await openPaths();
    await searchesAgain(reads, () => screen.getByLabelText('From') as HTMLInputElement);
  });

  it('searches the same text again from the start choice of a run', async () => {
    const reads = held<SearchResult>();
    const client = fakeClient({ searchEntities: (_request, signal) => reads.read(signal) });
    render(<StartChoice client={client} sourceId="a" sourceName="alpha" mask={false} typeName="Account" entityType="kind-a" candidates={[]} chosen={undefined} onChoose={() => undefined} showIds inputId="start" />);
    await searchesAgain(reads, () => within(document.body).getByRole('combobox') as HTMLInputElement);
  });
});
