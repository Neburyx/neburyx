import { watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Under load a watcher sometimes never reports the first write after it starts (4 of 300 starts with 12 busy processes, none idle), so a write that goes unreported for this long is written again under a new name. */
const SETTLE_RETRY_MS = 250;
const SETTLE_LIMIT_MS = 10_000;
const SETTLE_POLL_MS = 5;

type WatchFolder = (folder: string, options: { recursive: true }, listener: (event: string, name: string | null) => void) => { close: () => void };

export interface SettleOptions {
  readonly watchFolder?: WatchFolder;
  readonly retryMs?: number;
  readonly limitMs?: number;
}

/** Waits until a watcher has reported a file written in the folder. The tests do this before their own watcher starts, as a workaround to keep the creation of the folder from being reported to it; a reported name does not prove that every earlier event has been delivered. */
export async function settle(folder: string, options: SettleOptions = {}): Promise<void> {
  const { watchFolder = (path, watchOptions, listener) => watch(path, watchOptions, listener), retryMs = SETTLE_RETRY_MS, limitMs = SETTLE_LIMIT_MS } = options;
  const limit = Date.now() + limitMs;
  const reported = new Set<string>();
  const watcher = watchFolder(folder, { recursive: true }, (_event, name) => {
    if (name !== null) reported.add(name);
  });
  try {
    for (let attempt = 1; ; attempt += 1) {
      const name = `.settled-${attempt}`;
      writeFileSync(join(folder, name), '');
      const retryAt = Date.now() + retryMs;
      while (!reported.has(name) && Date.now() < retryAt && Date.now() < limit) await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      if (reported.has(name)) return;
      if (Date.now() >= limit) throw new Error('the file system did not report a file written in the folder');
    }
  } finally {
    watcher.close();
  }
}
