import type { AuditCounts, AuditSink } from '@neburyx/contracts';
import { createAuditQueue } from '../audit/queue.js';

/** The queued audit member of the application over a sink a test controls, with no retry so a failing sink is counted at once. */
export function queuedAudit(sink: AuditSink, warn: (fields: Record<string, unknown>) => void = () => undefined): { readonly audit: AuditSink; readonly counts: () => AuditCounts } {
  const queue = createAuditQueue({ sinks: [{ name: 'test', sink }], settings: { queueSize: 100, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 1000 }, logger: { warn } });
  return { audit: queue.sink, counts: queue.counts };
}
