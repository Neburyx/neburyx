import type { Investigation } from '@neburyx/contracts';
import { AppError } from '../errors.js';

export type ReadOnlyStatus = 'closed' | 'archived';

/** The status that makes an investigation refuse changes, or `undefined` while it is open. */
export function readOnlyStatusOf(status: Investigation['status']): ReadOnlyStatus | undefined {
  return status === 'open' ? undefined : status;
}

export function readOnlyRefusal(status: ReadOnlyStatus): AppError {
  return new AppError('CONFLICT', { reason: 'investigation-read-only', status });
}
