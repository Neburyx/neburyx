import { SOURCE_READS_IN_A_ROW, SOURCE_REQUEST_DEADLINE_MS } from '@neburyx/contracts';
import type { ApiResult } from './client.js';

/**
 * How long a read may wait for an answer before it is given up as a failure. The server answers sooner from its own database or the mapping, and one read of a source ends within the server's deadline of 10 s.
 */
export const READ_WAIT_MS = 15_000;

/** The room a chain of source reads is given over its deadlines, for the network and the server's own work. */
const CHAIN_MARGIN_MS = 5_000;
/** A wait for a request that reads a source several times in a row: longer than the longest the server can take over it, one deadline for each read. */
const chainWaitMs = (reads: number): number => reads * SOURCE_REQUEST_DEADLINE_MS + CHAIN_MARGIN_MS;

/** Search results and the entity pickers: the server can take 40 s. */
export const SEARCH_WAIT_MS = chainWaitMs(SOURCE_READS_IN_A_ROW.search);
/** The next page of a search group: the server can take 30 s. */
export const SEARCH_MORE_WAIT_MS = chainWaitMs(SOURCE_READS_IN_A_ROW.searchMore);
/** Type-ahead: the server can take 30 s. */
export const TYPEAHEAD_WAIT_MS = chainWaitMs(SOURCE_READS_IN_A_ROW.typeahead);
/** The rule-derived rows: the server can take 20 s. */
export const DERIVED_ROWS_WAIT_MS = chainWaitMs(SOURCE_READS_IN_A_ROW.derivedRows);
/** The evidence of an aggregate relationship: the server can take 20 s. */
export const AGGREGATE_EVIDENCE_WAIT_MS = chainWaitMs(SOURCE_READS_IN_A_ROW.aggregateEvidence);
/** The aggregate relationships a stored answer cites: the server can take 20 s. */
export const AGGREGATE_REFS_WAIT_MS = chainWaitMs(SOURCE_READS_IN_A_ROW.aggregateRefs);

/**
 * Makes a read that does not wait without end. With no answer after `waitMs` the request is aborted and the read fails as one that did not reach the server, so it can be tried again; an answer that comes later is dropped.
 * An abort by the caller's `signal` stays an abort.
 */
export function boundedRead<T>(load: (signal: AbortSignal) => Promise<ApiResult<T>>, signal?: AbortSignal, waitMs: number = READ_WAIT_MS): Promise<ApiResult<T>> {
  const own = new AbortController();
  return new Promise((resolve, reject) => {
    const cancel = (): void => {
      settle();
      resolve({ ok: false, failure: { code: 'ABORTED' } });
      own.abort();
    };
    const giveUp = setTimeout(() => {
      settle();
      resolve({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
      own.abort();
    }, waitMs);
    const settle = (): void => {
      clearTimeout(giveUp);
      signal?.removeEventListener('abort', cancel);
    };
    const fail = (error: unknown): void => {
      settle();
      reject(error instanceof Error ? error : new Error('the read failed'));
    };
    if (signal?.aborted === true) {
      cancel();
      return;
    }
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      load(own.signal).then((result) => {
        settle();
        resolve(result);
      }, fail);
    } catch (error) {
      fail(error);
    }
  });
}
