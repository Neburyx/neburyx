import { auditDetailSchema, type AuditEvent, type AuditSink } from '@neburyx/contracts';

export interface StdoutSinkOptions {
  /** Writes text to standard output and calls back with the failure, if any. */
  readonly write?: (text: string, done: (error?: Error | null) => void) => void;
  readonly clock?: () => Date;
}

const DEFAULT_WRITE: NonNullable<StdoutSinkOptions['write']> = (text, done) => {
  process.stdout.write(text, done);
};

/** One line of JSON for each event, for a log shipper or a SIEM: the fields of the event and the time it was written, and nothing else. A detail outside the known shapes is refused, as the store refuses it. */
export function createStdoutSink(options: StdoutSinkOptions = {}): AuditSink {
  const write = options.write ?? DEFAULT_WRITE;
  const clock = options.clock ?? (() => new Date());
  return {
    record(event: AuditEvent) {
      if (event.detail !== undefined && !auditDetailSchema.safeParse(event.detail).success) return Promise.reject(new Error('the audit event detail is not one of the known shapes'));
      const line = `${JSON.stringify({ at: clock().toISOString(), ...event })}\n`;
      return new Promise<void>((resolve, reject) => {
        write(line, (error) => (error === undefined || error === null ? resolve() : reject(new Error('the audit line could not be written'))));
      });
    },
  };
}
