import { AsyncLocalStorage } from 'node:async_hooks';
import type { ReadOrigin } from './seams.js';

const origins = new AsyncLocalStorage<ReadOrigin>();

/** The origin of the reads made while `work` runs: a read the gate starts under it is an AI read, whatever code asked for it. Only the core's gate client marks. */
export function asAiReads<T>(work: () => T): T {
  return origins.run('ai', work);
}

/** `manual` outside `asAiReads`. */
export function currentReadOrigin(): ReadOrigin {
  return origins.getStore() ?? 'manual';
}
