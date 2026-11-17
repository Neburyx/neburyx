import type { AuditCounts, AuditEvent, AuditSink, AuditWriteOptions } from '@neburyx/contracts';
import type { AuditSettings } from './settings.js';

/** What the queue needs of a logger. */
export interface AuditLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/** Where one queue writes: the same shape as an audit sink, for an event of any kind the queue carries. */
interface QueueSink<E> {
  record(event: E, options?: AuditWriteOptions): Promise<void>;
}

interface NamedSink<E> {
  readonly name: string;
  readonly sink: QueueSink<E>;
}

interface AuditTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EventQueue<E> {
  /** Takes an event and returns at once; it never throws and never waits for a sink. */
  readonly sink: QueueSink<E>;
  counts(): AuditCounts;
  /** Waits up to `limitMs` for the queues to empty, then stops the writers and drops what is left. */
  stop(limitMs: number): Promise<void>;
}

export type AuditQueue = EventQueue<AuditEvent>;

interface EventQueueOptions<E> {
  readonly sinks: readonly NamedSink<E>[];
  /** The ids and codes of an event that a log line may carry, and nothing else. */
  readonly idFields: (event: E) => Record<string, string>;
  readonly settings: AuditSettings;
  readonly logger: AuditLogger;
  readonly timers?: AuditTimers;
}

export interface AuditQueueOptions {
  readonly sinks: readonly NamedSink<AuditEvent>[];
  readonly settings: AuditSettings;
  readonly logger: AuditLogger;
  readonly timers?: AuditTimers;
}

const SYSTEM_TIMERS: AuditTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Only ids and codes of an event, never its detail. */
export function idFieldsOf(event: AuditEvent): Record<string, string> {
  const fields: Record<string, string> = { action: event.action, result: event.result, traceId: event.traceId, actorId: event.actorId };
  if (event.sourceId !== undefined) fields['sourceId'] = event.sourceId;
  if (event.investigationId !== undefined) fields['investigationId'] = event.investigationId;
  return fields;
}

interface Writer<E> {
  enqueue(event: E): void;
  queued(): number;
  idle(): Promise<void>;
  stop(): void;
}

interface Totals {
  written: number;
  failed: number;
  dropped: number;
}

function createWriter<E>(entry: NamedSink<E>, options: EventQueueOptions<E>, totals: Totals): Writer<E> {
  const { settings, logger } = options;
  const timers = options.timers ?? SYSTEM_TIMERS;
  const pending: E[] = [];
  let running = false;
  let stopped = false;
  let current: AbortController | undefined;
  let wakePause: (() => void) | undefined;
  let idleWaiters: (() => void)[] = [];

  const wake = (): void => {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  /** A wait that a stop ends at once. */
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const handle = timers.setTimeout(() => {
        wakePause = undefined;
        resolve();
      }, ms);
      wakePause = () => {
        timers.clearTimeout(handle);
        wakePause = undefined;
        resolve();
      };
    });

  /**
   * One attempt, under the write time limit. An attempt that outlives it is counted as failed at once, logged, aborted and never tried again (it may have been stored), and the next write
   * waits for it to settle so that the order holds; a late success is not counted a second time.
   */
  async function attempt(event: E): Promise<'ok' | 'failed' | 'timeout'> {
    const controller = new AbortController();
    current = controller;
    const settled = Promise.resolve()
      .then(() => entry.sink.record(event, { signal: controller.signal }))
      .then(
        () => 'ok' as const,
        () => 'failed' as const,
      );
    let handle: unknown;
    const limit = new Promise<'timeout'>((resolve) => {
      handle = timers.setTimeout(() => resolve('timeout'), settings.writeTimeoutMs);
    });
    const first = await Promise.race([settled, limit]);
    timers.clearTimeout(handle);
    if (first !== 'timeout') {
      current = undefined;
      return first;
    }
    controller.abort();
    totals.failed += 1;
    logger.warn({ event: 'audit.write_timeout', sink: entry.name, ...options.idFields(event) }, 'an audit write timed out');
    await settled;
    current = undefined;
    return 'timeout';
  }

  async function write(event: E): Promise<void> {
    for (let tries = 0; tries <= settings.retryLimit && (tries === 0 || !stopped); tries += 1) {
      const result = await attempt(event);
      if (result === 'ok') {
        totals.written += 1;
        return;
      }
      if (result === 'timeout') return;
      if (tries < settings.retryLimit && !stopped) await pause(settings.retryWaitMs * 2 ** tries);
    }
    totals.failed += 1;
    logger.warn({ event: 'audit.event_failed', sink: entry.name, ...options.idFields(event) }, 'an audit event could not be written');
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (pending.length > 0 && !stopped) {
        const event = pending[0];
        if (event === undefined) break;
        await write(event);
        pending.shift();
      }
    } finally {
      running = false;
      if (pending.length === 0) wake();
    }
  }

  return {
    enqueue(event) {
      if (stopped || pending.length >= settings.queueSize) {
        totals.dropped += 1;
        logger.warn({ event: 'audit.event_dropped', sink: entry.name, ...options.idFields(event) }, 'an audit event was dropped');
        return;
      }
      pending.push(event);
      void run();
    },
    queued: () => pending.length,
    idle: () =>
      pending.length === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            idleWaiters.push(resolve);
          }),
    stop() {
      stopped = true;
      current?.abort();
      wakePause?.();
      // the event being written is accounted for by its own write, once
      for (const event of pending.splice(running ? 1 : 0)) {
        totals.dropped += 1;
        logger.warn({ event: 'audit.event_dropped', sink: entry.name, ...options.idFields(event) }, 'an audit event was dropped');
      }
      wake();
    },
  };
}

export function createEventQueue<E>(options: EventQueueOptions<E>): EventQueue<E> {
  const totals: Totals = { written: 0, failed: 0, dropped: 0 };
  const writers = options.sinks.map((entry) => createWriter(entry, options, totals));
  const timers = options.timers ?? SYSTEM_TIMERS;
  return {
    sink: {
      record(event) {
        try {
          for (const writer of writers) writer.enqueue(event);
        } catch {
          totals.dropped += 1;
        }
        return Promise.resolve();
      },
    },
    counts: () => ({ ...totals, queued: writers.reduce((sum, writer) => sum + writer.queued(), 0) }),
    async stop(limitMs) {
      let handle: unknown;
      const limit = new Promise<void>((resolve) => {
        handle = timers.setTimeout(resolve, limitMs);
      });
      await Promise.race([Promise.all(writers.map((writer) => writer.idle())), limit]);
      timers.clearTimeout(handle);
      for (const writer of writers) writer.stop();
    },
  };
}

export function createAuditQueue(options: AuditQueueOptions): AuditQueue {
  return createEventQueue<AuditEvent>({ ...options, idFields: idFieldsOf });
}
