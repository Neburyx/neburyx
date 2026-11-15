import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiFailure, ApiResult } from '../api/client.js';
import type { PathsResponse } from '@neburyx/contracts';
import { chooseEnd, okPaths, openPaths, pathsWorkspace, settle, type SentSearch } from './paths-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const find = (): HTMLElement => screen.getByRole('button', { name: 'Find paths' });
type Answer = ApiResult<PathsResponse>;

interface Held {
  readonly sent: SentSearch;
  readonly answer: (result: Answer) => void;
}

function holding() {
  const held: Held[] = [];
  const handler = (sent: SentSearch): Promise<Answer> =>
    new Promise((resolve) => {
      held.push({ sent, answer: resolve });
      sent.signal?.addEventListener('abort', () => resolve({ ok: false, failure: { code: 'ABORTED' } }));
    });
  return { held, handler };
}

async function started(kit: Awaited<ReturnType<typeof pathsWorkspace>>): Promise<void> {
  await openPaths();
  chooseEnd('From', 'acc-1');
  chooseEnd('To', 'acc-2');
  await userEvent.click(find());
  await settle();
  void kit;
}

describe('a running search in the panel', () => {
  it('shows Cancel instead of Find paths while it runs, aborts it on Cancel and keeps the previous list and the fields', async () => {
    const { held, handler } = holding();
    let first = true;
    const kit = await pathsWorkspace({ find: (sent) => (first ? ((first = false), Promise.resolve({ ok: true as const, value: okPaths([['acc-1', 'acc-2']]) })) : handler(sent)) });
    await started(kit);
    await userEvent.click(find());
    await settle();
    expect(screen.queryByRole('button', { name: 'Find paths' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(held[0]?.sent.signal?.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Find paths' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Paths found' })).toBeTruthy();
    expect((screen.getByLabelText('To') as HTMLSelectElement).value).not.toBe('');
  });

  it('cancels on Esc while a search runs and the panel stays; Esc with no search running closes it', async () => {
    const { held, handler } = holding();
    const kit = await pathsWorkspace({ find: handler });
    await started(kit);
    fireEvent.keyDown(screen.getByLabelText('From'), { key: 'Escape' });
    await settle();
    expect(held[0]?.sent.signal?.aborted).toBe(true);
    expect(screen.getByRole('heading', { name: 'Bounded path search' })).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('From'), { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('heading', { name: 'Bounded path search' })).toBeNull();
  });

  it('never shows the answer of a cancelled search', async () => {
    const { held, handler } = holding();
    const kit = await pathsWorkspace({ find: handler });
    await started(kit);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    held[0]?.answer({ ok: true, value: okPaths([['acc-1', 'acc-2']]) });
    await settle();
    expect(screen.queryByRole('list', { name: 'Paths found' })).toBeNull();
  });
});

const refused = (details: Record<string, unknown>): ApiFailure => ({ code: 'QUERY_BUDGET_EXCEEDED', message: 'm', traceId: 't', retryable: true, details });

describe('a refused or failed search', () => {
  it.each([
    [{ maxHops: 4 }, "This is above the source's limit: at most 4 hops."],
    [{ pathResultsCap: 25 }, "This is above the source's limit: at most 25 paths."],
    [{ maxPage: 10 }, "This is above the source's limit: at most 10 paths."],
  ])('says the request is above the source limit and names the cap (%j), keeps the fields and offers no Retry', async (details, text) => {
    await pathsWorkspace({ find: async () => ({ ok: false, failure: refused(details) }) });
    await openPaths();
    chooseEnd('From', 'acc-1');
    chooseEnd('To', 'acc-2');
    fireEvent.change(screen.getByLabelText('Max hops'), { target: { value: '9' } });
    await userEvent.click(find());
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(text);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect((screen.getByLabelText('Max hops') as HTMLInputElement).value).toBe('9');
  });

  it.each(['QUERY_TIMEOUT', 'SOURCE_UNAVAILABLE', 'SOURCE_BUSY', 'RATE_LIMITED'] as const)('puts %s on the app banner with its recovery action, and keeps the fields and the previous list', async (code) => {
    let answers = 0;
    const kit = await pathsWorkspace({
      find: async () => (answers++ === 0 ? { ok: true, value: okPaths([['acc-1', 'acc-2']]) } : { ok: false, failure: { code, message: 'm', traceId: 't', retryable: true, details: code === 'QUERY_TIMEOUT' ? { timeoutMs: 5000 } : code === 'RATE_LIMITED' ? { retryAfterMs: 12000 } : code === 'SOURCE_UNAVAILABLE' ? { reason: 'unreachable' } : {} } }),
    });
    const shown = vi.spyOn(kit.banner, 'showFailure');
    await openPaths();
    chooseEnd('From', 'acc-1');
    chooseEnd('To', 'acc-2');
    await userEvent.click(find());
    await settle();
    await userEvent.click(find());
    await settle();
    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown.mock.calls[0]?.[0].code).toBe(code);
    expect(screen.getByRole('list', { name: 'Paths found' })).toBeTruthy();
    expect((screen.getByLabelText('From') as HTMLSelectElement).value).not.toBe('');
    void act;
  });
});
