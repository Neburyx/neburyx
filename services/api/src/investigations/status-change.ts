import type { Investigation } from '@neburyx/contracts';

type Status = Investigation['status'];

/** What a move to another status does to `closed_at` and `archived_at`: keep the stored time, set it to now, or clear it. */
export interface StatusChangePlan {
  readonly closedAt: 'keep' | 'now' | 'clear';
  readonly archivedAt: 'keep' | 'now' | 'clear';
}

/**
 * Open can be closed or archived, closed can be reopened or archived, archived can only be reopened.
 * Archiving keeps an earlier `closed_at`; reopening clears both times.
 */
export function planStatusChange(from: Status, to: Status): StatusChangePlan | 'unchanged' | 'not-allowed' {
  if (from === to) return 'unchanged';
  if (to === 'open') return { closedAt: 'clear', archivedAt: 'clear' };
  if (to === 'closed') return from === 'archived' ? 'not-allowed' : { closedAt: 'now', archivedAt: 'keep' };
  return { closedAt: 'keep', archivedAt: 'now' };
}

export function auditActionOf(from: Status, to: Status): 'investigation.close' | 'investigation.archive' | 'investigation.reopen' {
  if (to === 'open') return 'investigation.reopen';
  return to === 'closed' ? 'investigation.close' : 'investigation.archive';
}
