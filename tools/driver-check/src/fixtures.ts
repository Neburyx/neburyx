import { readClose, readTimeout, type CallEnd, type CloseEnd, type Sample } from './readings.js';
import type { CloseResult, Findings } from './types.js';

export function samples(from: number, to: number, state: (atMs: number) => Sample['state']): Sample[] {
  const out: Sample[] = [];
  for (let atMs = from; atMs <= to; atMs += 500) out.push({ sentMs: atMs, atMs, state: state(atMs) });
  return out;
}

const raised: CallEnd = { kind: 'raised', atMs: 1100, errorClass: 'Neo4jError', code: 'Neo.ClientError.Transaction.TransactionTimedOut' };

function closeResult(target: 'transaction' | 'session', observed: readonly Sample[], closeEnd: CloseEnd): CloseResult {
  return {
    target,
    end: raised,
    closeEnd,
    samples: observed,
    reading: readClose(observed, 2000, 20_000, false),
    driverReuse: { ok: true },
  };
}

export interface FindingsOptions {
  readonly neverSeen?: boolean;
  readonly closeEnd?: CloseEnd;
  readonly cleanupFailures?: readonly string[];
  readonly quickMs?: number;
}

export function findings(options: FindingsOptions = {}): Findings {
  const timeoutSamples = samples(-500, 16_200, (t) => (options.neverSeen || t >= 1000 ? 'absent' : 'running'));
  const closeSamples = samples(-500, 45_200, (t) => (t < 2300 ? 'running' : 'absent'));
  const closeEnd = options.closeEnd ?? { kind: 'returned', calledAtMs: 2000, atMs: 2010 };
  return {
    facts: { image: 'neo4j:test', serverVersion: '0.0.0', edition: 'community', driverVersion: '0.0.0' },
    timeout: {
      end: raised,
      samples: timeoutSamples,
      reading: readTimeout(timeoutSamples, raised, 1000, 15_000),
      sessionReuse: { ok: true },
    },
    quick: { returned: true, rows: 1, elapsedMs: options.quickMs ?? 40 },
    closes: [closeResult('transaction', closeSamples, closeEnd), closeResult('session', closeSamples, closeEnd)],
    cleanupFailures: options.cleanupFailures ?? [],
  };
}
