import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ApiResult, ClientFailure } from './client.js';
import { useRequest } from './use-request.js';

interface Deferred {
  readonly signal: AbortSignal;
  resolve(result: ApiResult<string>): void;
}

function Probe({ load }: { readonly load: (signal: AbortSignal) => Promise<ApiResult<string>> }) {
  const { state, reload, cancel } = useRequest(load);
  const failure = state.phase === 'failed' || state.phase === 'ready' ? state.failure : undefined;
  return (
    <div>
      <output aria-label="phase">{state.phase}</output>
      <output aria-label="data">{state.phase === 'ready' || state.phase === 'loading' ? (state.data ?? '') : ''}</output>
      <output aria-label="failure">{failure?.code ?? ''}</output>
      <button onClick={reload}>Reload</button>
      <button onClick={cancel}>Cancel</button>
    </div>
  );
}

function deferredLoad() {
  const calls: Deferred[] = [];
  const load = (signal: AbortSignal) =>
    new Promise<ApiResult<string>>((resolve) => {
      calls.push({ signal, resolve });
    });
  return { calls, load };
}

const ok = (value: string): ApiResult<string> => ({ ok: true, value });
const fail = (code: ClientFailure['code']): ApiResult<string> => ({ ok: false, failure: { code } });
const text = (name: string) => screen.getByRole('status', { name }).textContent;

describe('useRequest', () => {
  it('shows loading while the answer is awaited and then the data', async () => {
    const { calls, load } = deferredLoad();
    render(<Probe load={load} />);
    expect(text('phase')).toBe('loading');
    await act(async () => calls[0]?.resolve(ok('first')));
    expect(text('phase')).toBe('ready');
    expect(text('data')).toBe('first');
  });

  it('keeps the data on screen and shows the failure beside it when a later request fails', async () => {
    const { calls, load } = deferredLoad();
    render(<Probe load={load} />);
    await act(async () => calls[0]?.resolve(ok('first')));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect(text('phase')).toBe('loading');
    expect(text('data')).toBe('first');
    await act(async () => calls[1]?.resolve(fail('NETWORK_UNAVAILABLE')));
    expect(text('phase')).toBe('ready');
    expect(text('data')).toBe('first');
    expect(text('failure')).toBe('NETWORK_UNAVAILABLE');
  });

  it('shows a failure and no data when the first request fails', async () => {
    const { calls, load } = deferredLoad();
    render(<Probe load={load} />);
    await act(async () => calls[0]?.resolve(fail('SCHEMA_MISMATCH')));
    expect(text('phase')).toBe('failed');
    expect(text('failure')).toBe('SCHEMA_MISMATCH');
  });

  it('shows the newest answer when an older request answers after it', async () => {
    const { calls, load } = deferredLoad();
    render(<Probe load={load} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal.aborted).toBe(true);
    await act(async () => calls[1]?.resolve(ok('newer')));
    await act(async () => calls[0]?.resolve(ok('older')));
    expect(text('data')).toBe('newer');
  });

  it('goes back to what it showed, with no error, when the caller cancels', async () => {
    const { calls, load } = deferredLoad();
    render(<Probe load={load} />);
    await act(async () => calls[0]?.resolve(ok('first')));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls[1]?.signal.aborted).toBe(true);
    expect(text('phase')).toBe('ready');
    expect(text('data')).toBe('first');
    expect(text('failure')).toBe('');
    await act(async () => calls[1]?.resolve(ok('too late')));
    expect(text('data')).toBe('first');
  });

  it('shows idle, with no error, when the first request is cancelled', async () => {
    const { calls, load } = deferredLoad();
    render(<Probe load={load} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(text('phase')).toBe('idle');
    await act(async () => calls[0]?.resolve(fail('ABORTED')));
    expect(text('failure')).toBe('');
  });

  it('shows UNEXPECTED_FAILURE, and keeps the data, when a load rejects instead of answering', async () => {
    let calls = 0;
    const load = (): Promise<ApiResult<string>> => {
      calls += 1;
      return calls === 1 ? Promise.resolve(ok('first')) : Promise.reject(new Error('boom'));
    };
    render(<Probe load={load} />);
    await screen.findByText('first');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    await screen.findByText('UNEXPECTED_FAILURE');
    expect(text('data')).toBe('first');
    expect(text('phase')).toBe('ready');
  });

  it('shows UNEXPECTED_FAILURE instead of loading for ever when the first load rejects', async () => {
    render(<Probe load={() => Promise.reject(new Error('boom'))} />);
    expect(await screen.findByText('UNEXPECTED_FAILURE')).toBeTruthy();
    expect(text('phase')).toBe('failed');
  });

  it('aborts the request when the component goes away', () => {
    const { calls, load } = deferredLoad();
    const { unmount } = render(<Probe load={load} />);
    unmount();
    expect(calls[0]?.signal.aborted).toBe(true);
  });
});
