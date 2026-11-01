import { errorCode, isConnectionError } from '../database-errors.js';

const UNDEFINED_TABLE = '42P01';

export class IdentityStartError extends Error {
  constructor(readonly kind: 'unreachable' | 'not-migrated') {
    super(kind === 'unreachable' ? 'the database could not be reached' : 'the database has not been migrated');
  }
}

export function toStartError(error: unknown): unknown {
  if (isConnectionError(error)) return new IdentityStartError('unreachable');
  if (errorCode(error) === UNDEFINED_TABLE) return new IdentityStartError('not-migrated');
  return error;
}
