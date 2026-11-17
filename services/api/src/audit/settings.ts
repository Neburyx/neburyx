export interface AuditSettings {
  readonly queueSize: number;
  readonly retryLimit: number;
  readonly retryWaitMs: number;
  readonly writeTimeoutMs: number;
}

interface Bounds {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

export const AUDIT_QUEUE_SIZE_BOUNDS: Bounds = { default: 1000, min: 1, max: 100_000 };
export const AUDIT_RETRY_LIMIT_BOUNDS: Bounds = { default: 3, min: 0, max: 10 };
export const AUDIT_RETRY_WAIT_BOUNDS: Bounds = { default: 500, min: 10, max: 60_000 };
export const AUDIT_WRITE_TIMEOUT_BOUNDS: Bounds = { default: 5000, min: 100, max: 60_000 };

/** The default for an absent or empty setting; `undefined` for a value that is not a whole number within the bounds. */
export function parseAuditNumber(value: string | undefined, bounds: Bounds): number | undefined {
  if (value === undefined || value === '') return bounds.default;
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return number >= bounds.min && number <= bounds.max ? number : undefined;
}

/** How long a graceful stop waits for the queues to empty; what is still queued after it is lost. */
export const AUDIT_STOP_LIMIT_MS = 5000;

export function auditSettingsOf(config: { readonly auditQueueSize: number; readonly auditRetryLimit: number; readonly auditRetryWaitMs: number; readonly auditWriteTimeoutMs: number }): AuditSettings {
  return { queueSize: config.auditQueueSize, retryLimit: config.auditRetryLimit, retryWaitMs: config.auditRetryWaitMs, writeTimeoutMs: config.auditWriteTimeoutMs };
}

export const AUDIT_SINK_NAMES = ['postgres', 'stdout'] as const;
export type AuditSinkName = (typeof AUDIT_SINK_NAMES)[number];

/** The sinks named by `NEBURYX_AUDIT_SINKS`, a comma separated list; absent or empty is the built-in store. `undefined` for a name that is not a sink, a repeated name or an empty entry. */
export function parseAuditSinks(value: string | undefined): readonly AuditSinkName[] | undefined {
  if (value === undefined || value.trim() === '') return ['postgres'];
  const names: AuditSinkName[] = [];
  for (const raw of value.split(',')) {
    const name = AUDIT_SINK_NAMES.find((known) => known === raw.trim());
    if (name === undefined || names.includes(name)) return undefined;
    names.push(name);
  }
  return names;
}
