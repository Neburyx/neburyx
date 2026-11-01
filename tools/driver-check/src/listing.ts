import neo4j, { type Driver } from 'neo4j-driver';
import type { Rows } from './backend.js';
import { describeError, settle, type Look, type LookResult, type Settled } from './probe.js';
import { CLEANUP_LIMIT_MS, POLL_LIMIT_MS } from './settings.js';

const LIST = `SHOW TRANSACTIONS YIELD transactionId, metaData, status, currentQuery
WHERE metaData.check = $marker
RETURN status, currentQuery`;

function lookAt(answered: Settled<Rows>): Look {
  if (answered.kind === 'unsettled') return { state: 'unreadable', detail: `no answer within ${POLL_LIMIT_MS} ms` };
  if (answered.kind === 'error') return { state: 'unreadable', detail: describeError(answered.error).code };
  const row = answered.value.records[0];
  if (!row) return { state: 'absent' };
  const status = String(row.get('status'));
  if (!status.startsWith('Running')) return { state: 'ending', detail: status };
  return String(row.get('currentQuery') ?? '').length > 0 ? { state: 'running', detail: status } : { state: 'idle', detail: status };
}

/**
 * One look at the transaction carrying `marker` in its metadata; a transaction with no query running is idle.
 * The answer time is taken before the observer session is closed, and the close is returned to be awaited by the caller.
 */
export async function listTransactions(observer: Driver, marker: string): Promise<LookResult> {
  const session = observer.session({ defaultAccessMode: neo4j.session.READ });
  const look = lookAt(await settle(session.run(LIST, { marker }), POLL_LIMIT_MS, performance.now()));
  const answeredAt = performance.now();
  const cleanup = settle(session.close(), CLEANUP_LIMIT_MS, performance.now()).then((closed) => {
    if (closed.kind === 'value') return undefined;
    return closed.kind === 'error'
      ? `observer session: ${describeError(closed.error).code}`
      : `observer session: did not close within ${CLEANUP_LIMIT_MS} ms`;
  });
  return { look, answeredAt, cleanup };
}
