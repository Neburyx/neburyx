import { useState } from 'react';
import type { DeleteInvestigationResponse } from '@neburyx/contracts';
import type { ApiFailure, ApiResult } from '../api/client.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { DELETE_INVESTIGATION, DELETE_TEXT, DELETE_TITLE, DELETING, RELOAD } from './copy.js';
import { messageOf } from './status-flow.js';

export interface DeleteTarget {
  readonly id: string;
  readonly version: number;
}

export interface DeleteDialogProps {
  /** The investigation as the caller holds it now: a version that changes while the dialog is open (a reload) is taken from here. */
  readonly target: DeleteTarget;
  /** Sends the delete; the caller decides what must settle first. */
  readonly send: (target: DeleteTarget) => Promise<ApiResult<DeleteInvestigationResponse>>;
  readonly onDeleted: (answer: DeleteInvestigationResponse) => void;
  /** The investigation is not there to delete (already deleted, purged, or not the caller's). */
  readonly onGone: () => void;
  /** Reads the investigation again and tells the caller what it holds; false when that could not be done. */
  readonly refresh: () => Promise<boolean>;
  /** The version was stale: the caller may read what it shows again at once, while the dialog keeps its message. */
  readonly onConflict?: (() => void) | undefined;
  readonly onClose: () => void;
}

/** The confirm that asks before an investigation is deleted. Nothing leaves the screen on a failure: the dialog stays with the server's own message, and a version that changed elsewhere offers Reload. */
export function DeleteInvestigationDialog({ target, send, onDeleted, onGone, refresh, onConflict, onClose }: DeleteDialogProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);

  const confirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    const result = await send(target);
    if (result.ok) {
      onDeleted(result.value);
      onClose();
      return;
    }
    setBusy(false);
    if (result.failure.code === 'NOT_FOUND') {
      onGone();
      onClose();
      return;
    }
    if (result.failure.code === 'CONFLICT') onConflict?.();
    setFailure(result.failure);
  };

  const reload = failure !== undefined && failure.code === 'CONFLICT';
  return (
    <ConfirmDialog
      title={DELETE_TITLE}
      confirmLabel={DELETE_INVESTIGATION}
      busyLabel={DELETING}
      busy={busy}
      canConfirm
      initialFocus="cancel"
      onConfirm={() => void confirm()}
      onClose={onClose}
      message={
        failure === undefined ? undefined : (
          <>
            {messageOf(failure)}
            {reload ? (
              <>
                {' '}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void refresh().then((refreshed) => setFailure(refreshed ? undefined : { code: 'NETWORK_UNAVAILABLE' }));
                  }}
                >
                  {RELOAD}
                </button>
              </>
            ) : null}
          </>
        )
      }
    >
      <p>{DELETE_TEXT}</p>
    </ConfirmDialog>
  );
}
