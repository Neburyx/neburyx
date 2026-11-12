import { unreachableMessage } from '../db/connect-timeout.js';
import { connectionCause, errorCode, isConnectionError, type ConnectionCause } from '../database-errors.js';

const UNDEFINED_TABLE = '42P01';

export class IdentityStartError extends Error {
  constructor(readonly kind: 'unreachable' | 'not-migrated', cause?: ConnectionCause) {
    super(kind === 'unreachable' ? unreachableMessage(cause) : 'the database has not been migrated');
  }
}

export function toStartError(error: unknown): unknown {
  if (isConnectionError(error)) return new IdentityStartError('unreachable', connectionCause(error));
  if (errorCode(error) === UNDEFINED_TABLE) return new IdentityStartError('not-migrated');
  return error;
}
