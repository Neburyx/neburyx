/** How often the server's list of running transactions is looked at, both while waiting for the read to appear in it and while waiting for it to leave it. */
export const LIST_INTERVAL_MS = 25;

/** How a read ended: as cancelled by the abort, or any other way (answered, or failed). */
export type ReadEnd = 'cancelled' | 'other';

export type CancelObservation =
  /** The read was running when it was aborted, and the first look that found its transaction gone came `goneAfterMs` after the abort. */
  | { readonly kind: 'gone'; readonly goneAfterMs: number; readonly looks: number }
  /** The read ended before it was aborted (or before its transaction was ever listed): there is no time to record. */
  | { readonly kind: 'finished-first' }
  /** The transaction was still listed when the wait ended. */
  | { readonly kind: 'not-gone'; readonly waitedMs: number; readonly looks: number };

export interface TransactionWatch {
  /** Whether the server lists a running transaction of this read. */
  isListed(): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface CancelLimits {
  /** How long to wait for the transaction to be listed before the read is taken to have finished first. */
  readonly appearMs: number;
  /** How long after the abort the transaction may stay listed; the source's transaction timeout. */
  readonly goneMs: number;
  readonly intervalMs?: number;
}

/**
 * Starts a read, aborts it once the server lists its transaction as running, and looks at the list until the transaction is gone. The time is the first look that found it gone, counted
 * from the abort, so it is exact only to within one look and one round trip of the list; it is a figure to record, never a promise.
 */
export async function observeCancel(start: (signal: AbortSignal) => Promise<ReadEnd>, watch: TransactionWatch, limits: CancelLimits): Promise<CancelObservation> {
  const interval = limits.intervalMs ?? LIST_INTERVAL_MS;
  const controller = new AbortController();
  let ended: ReadEnd | undefined;
  const reading = start(controller.signal).then(
    (end) => void (ended = end),
    () => void (ended = 'other'),
  );
  const began = watch.now();
  let listed = false;
  while (ended === undefined && !listed && watch.now() - began < limits.appearMs) {
    listed = await watch.isListed();
    if (!listed && ended === undefined) await watch.sleep(interval);
  }
  if (!listed || ended !== undefined) {
    controller.abort();
    await reading;
    return { kind: 'finished-first' };
  }
  const abortedAt = watch.now();
  controller.abort();
  let looks = 0;
  for (;;) {
    looks += 1;
    if (!(await watch.isListed())) {
      await reading;
      return { kind: 'gone', goneAfterMs: watch.now() - abortedAt, looks };
    }
    if (watch.now() - abortedAt >= limits.goneMs) {
      await reading;
      return { kind: 'not-gone', waitedMs: watch.now() - abortedAt, looks };
    }
    await watch.sleep(interval);
  }
}

/** One line for the test output: what was observed, with the look interval stated. */
export function describeObservation(label: string, observation: CancelObservation, intervalMs = LIST_INTERVAL_MS): string {
  switch (observation.kind) {
    case 'gone':
      return `${label}: transaction first observed gone ${observation.goneAfterMs.toFixed(0)} ms after the abort (${observation.looks} looks, one every ${intervalMs} ms)`;
    case 'finished-first':
      return `${label}: the read finished before it could be aborted; no time recorded`;
    case 'not-gone':
      return `${label}: transaction still listed ${observation.waitedMs.toFixed(0)} ms after the abort (${observation.looks} looks)`;
    default: {
      const unreachable: never = observation;
      return unreachable;
    }
  }
}
