import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settle } from './settle.js';

type Listener = (event: string, name: string | null) => void;

const RETRY_MS = 250;
const folders: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** Starts settle on a new folder with a watcher the test drives: the listener is given to the test and nothing is reported unless it says so. */
function start(options: { limitMs?: number; held?: () => void } = {}): { folder: string; listener: () => Listener; closed: () => boolean; outcome: Promise<Error | undefined> } {
  const folder = mkdtempSync(join(tmpdir(), 'settle-'));
  folders.push(folder);
  let listener: Listener | undefined;
  let closed = false;
  const outcome = settle(folder, {
    retryMs: RETRY_MS,
    ...(options.limitMs === undefined ? {} : { limitMs: options.limitMs }),
    watchFolder: (_folder, _options, report) => {
      listener = report;
      options.held?.();
      return { close: () => void (closed = true) };
    },
  }).then(
    () => undefined,
    (error: Error) => error,
  );
  return {
    folder,
    listener: () => {
      if (listener === undefined) throw new Error('the watcher was not started');
      return listener;
    },
    closed: () => closed,
    outcome,
  };
}

describe('settle', () => {
  it('returns when the watcher reports the first write', async () => {
    const run = start();
    run.listener()('rename', '.settled-1');
    await vi.advanceTimersByTimeAsync(10);
    expect(await run.outcome).toBeUndefined();
    expect(readdirSync(run.folder)).toEqual(['.settled-1']);
    expect(run.closed()).toBe(true);
  });

  it('writes again under a new name when the watcher reported nothing for the retry interval, and returns when that one is reported', async () => {
    const run = start();
    await vi.advanceTimersByTimeAsync(RETRY_MS + 10);
    expect(readdirSync(run.folder)).toEqual(['.settled-1', '.settled-2']);
    run.listener()('rename', '.settled-2');
    await vi.advanceTimersByTimeAsync(10);
    expect(await run.outcome).toBeUndefined();
  });

  it('does not take the report of an earlier write for the latest', async () => {
    const run = start();
    await vi.advanceTimersByTimeAsync(RETRY_MS + 10);
    run.listener()('rename', '.settled-1');
    await vi.advanceTimersByTimeAsync(RETRY_MS - 20);
    expect(readdirSync(run.folder)).toEqual(['.settled-1', '.settled-2']);
    await vi.advanceTimersByTimeAsync(30);
    expect(readdirSync(run.folder)).toEqual(['.settled-1', '.settled-2', '.settled-3']);
    run.listener()('rename', '.settled-3');
    await vi.advanceTimersByTimeAsync(10);
    expect(await run.outcome).toBeUndefined();
  });

  it('is not undone by the report of an earlier write that arrives after the report of the latest', async () => {
    const run = start();
    await vi.advanceTimersByTimeAsync(RETRY_MS + 10);
    run.listener()('rename', '.settled-2');
    run.listener()('rename', '.settled-1');
    await vi.advanceTimersByTimeAsync(10);
    expect(await run.outcome).toBeUndefined();
  });

  it('ignores a report that names no file', async () => {
    const run = start();
    run.listener()('rename', null);
    await vi.advanceTimersByTimeAsync(RETRY_MS - 10);
    run.listener()('rename', '.settled-1');
    await vi.advanceTimersByTimeAsync(10);
    expect(await run.outcome).toBeUndefined();
    expect(readdirSync(run.folder)).toEqual(['.settled-1']);
  });

  it('gives up at the limit, with the watcher closed, when nothing is ever reported', async () => {
    const run = start({ limitMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await run.outcome)?.message).toContain('did not report');
    expect(run.closed()).toBe(true);
    expect(readdirSync(run.folder)).toEqual(['.settled-1', '.settled-2', '.settled-3', '.settled-4']);
  });

  it('measures the limit on the clock, so a start held up past it gives up after one write', async () => {
    const run = start({ limitMs: 1000, held: () => vi.setSystemTime(Date.now() + 2000) });
    expect((await run.outcome)?.message).toContain('did not report');
    expect(readdirSync(run.folder)).toEqual(['.settled-1']);
  });
});
