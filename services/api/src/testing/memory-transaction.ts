import type { AuditTransaction } from '@neburyx/contracts';

/** What the in-memory stores hand a callback that runs "inside the transaction": there is no database, so a query does nothing, and a throw leaves the store as it was because the change is applied after the callback. */
export const MEMORY_TRANSACTION: AuditTransaction = { query: () => Promise.resolve(undefined) };
