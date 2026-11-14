import type { AuditEvent } from '@neburyx/contracts';

/** The events the extension's own audit sink received (the classification's model calls): a test file gives `vi.mock('@neburyx/ee-audit', ...)` this module's `auditMock`, so no database is needed. */
export const modelEvents: AuditEvent[] = [];

export const auditMock = {
  createAuditSink: () => ({
    sink: {
      record: (event: AuditEvent): Promise<void> => {
        modelEvents.push(event);
        return Promise.resolve();
      },
    },
    close: (): Promise<void> => Promise.resolve(),
  }),
};
