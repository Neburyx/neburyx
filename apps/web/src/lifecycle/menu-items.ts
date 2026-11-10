import type { InvestigationStatus } from '../state/investigation-state.js';
import { ARCHIVE, CLOSE, DELETE, RENAME, RENAME_DISABLED, REOPEN } from './copy.js';

export type LifecycleActionId = 'rename' | 'reopen' | 'close' | 'archive' | 'delete';

export interface LifecycleAction {
  readonly id: LifecycleActionId;
  readonly label: string;
  readonly description?: string;
  readonly disabled: boolean;
  /** Delete is drawn red and set apart from the status items. */
  readonly tone?: 'danger';
}

/** The items the menu offers an investigation of this status: Rename, Close and Archive when open; Reopen and Archive when closed; Reopen when archived, with Rename disabled while it cannot be changed; and Delete, set apart, whatever the status. */
export function lifecycleActionsOf(status: InvestigationStatus, busy: boolean): readonly LifecycleAction[] {
  const editable = status === 'open';
  return [
    { id: 'rename', label: RENAME, ...(editable ? {} : { description: RENAME_DISABLED }), disabled: !editable },
    ...(editable ? [] : [{ id: 'reopen' as const, label: REOPEN, disabled: busy }]),
    ...(editable ? [{ id: 'close' as const, label: CLOSE, disabled: busy }] : []),
    ...(status === 'archived' ? [] : [{ id: 'archive' as const, label: ARCHIVE, disabled: busy }]),
    { id: 'delete', label: DELETE, disabled: busy, tone: 'danger' },
  ];
}
