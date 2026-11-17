import type { AuditCounts, AuditSink, MountedAuditSink } from '@neburyx/contracts';
import { communityAudit } from '../seams/community-seams.js';
import { createAuditQueue, type AuditLogger, type AuditQueue } from './queue.js';
import type { AuditSettings, AuditSinkName } from './settings.js';
import { createStdoutSink } from './stdout-sink.js';

/** The counts of every queue of the process added together. */
export function combinedCounts(counters: readonly (() => AuditCounts)[]): AuditCounts {
  return counters.map((counts) => counts()).reduce((sum, counts) => ({ written: sum.written + counts.written, failed: sum.failed + counts.failed, dropped: sum.dropped + counts.dropped, queued: sum.queued + counts.queued }), { written: 0, failed: 0, dropped: 0, queued: 0 });
}

/** Stops every queue under one deadline, so a graceful stop waits for the slowest and not for each in turn. */
export async function stopQueues(queues: readonly ({ stop(limitMs: number): Promise<void> } | undefined)[], limitMs: number): Promise<void> {
  await Promise.all(queues.map((queue) => queue?.stop(limitMs)));
}

export interface AuditWiringInput {
  readonly sinkNames: readonly AuditSinkName[];
  /** The built-in store's sink, when the extension that provides it is loaded. */
  readonly mounted: MountedAuditSink | undefined;
  /** Whether the gate and the privileged writers use the built-in store (the enterprise audit of the old switch). */
  readonly storeInUse: boolean;
  readonly settings: AuditSettings;
  readonly logger: AuditLogger;
  readonly stdout?: AuditSink;
}

export interface AuditWiring {
  readonly queue: AuditQueue | undefined;
  /** Where ordinary events of the application go; absent, the Community default. */
  readonly audit: AuditSink | undefined;
  /** Where the events of privileged actions go, written directly: the store's sink, or the Community default that keeps nothing. Never the queue, whatever the sinks chosen. */
  readonly privilegedAudit: AuditSink;
}

/** Ordinary events go through one queue to the sinks the operator chose; a privileged event goes to the built-in store directly, whichever sinks are chosen. */
export function wireAudit(input: AuditWiringInput): AuditWiring {
  const stdout = input.sinkNames.includes('stdout');
  const sinks = [
    ...(input.sinkNames.includes('postgres') && input.mounted !== undefined ? [{ name: 'postgres', sink: input.mounted.sink }] : []),
    ...(stdout ? [{ name: 'stdout', sink: input.stdout ?? createStdoutSink() }] : []),
  ];
  const queue = sinks.length === 0 ? undefined : createAuditQueue({ sinks, settings: input.settings, logger: input.logger });
  return {
    queue,
    audit: queue !== undefined && (input.storeInUse || stdout) ? queue.sink : undefined,
    privilegedAudit: input.mounted !== undefined && input.storeInUse ? input.mounted.sink : communityAudit,
  };
}
