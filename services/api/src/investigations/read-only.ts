import type { Investigation, InvestigationSourceState } from '@neburyx/contracts';
import { AppError } from '../errors.js';

export type ReadOnlyStatus = 'closed' | 'archived';

/** The status that makes an investigation refuse changes, or `undefined` while it is open. */
export function readOnlyStatusOf(status: Investigation['status']): ReadOnlyStatus | undefined {
  return status === 'open' ? undefined : status;
}

export function readOnlyRefusal(status: ReadOnlyStatus): AppError {
  return new AppError('CONFLICT', { reason: 'investigation-read-only', status });
}

export function sourceChangedError(state: Exclude<InvestigationSourceState, 'available'>): AppError {
  return new AppError('CONFLICT', { reason: 'source-changed', sourceState: state });
}

/** The refusal of a write to an investigation whose source is re-pointed or no longer configured; `undefined` while the source is as it was. */
export function sourceChangedRefusal(state: InvestigationSourceState): AppError | undefined {
  return state === 'available' ? undefined : sourceChangedError(state);
}
