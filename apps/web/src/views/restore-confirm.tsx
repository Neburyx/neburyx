import type { NamedView } from '@neburyx/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { useApiClient } from '../api/client-context.js';
import { useClientState } from '../state/context.js';
import { CANCEL, RELOAD, RESTORE_FAILED, RESTORE_INTO_DRAFT, RESTORE_READ_FAILED, RESTORE_REASSURANCE, RESTORE_TITLE, RESTORING, TRY_AGAIN, restoreWarning } from './copy.js';
import { Dialog } from './dialog.js';
import { restoreNamedView, type RestoreOutcome } from './restore-view.js';

type Phase = { readonly kind: 'asking' } | { readonly kind: 'busy' } | { readonly kind: 'failed' } | { readonly kind: 'read-failed'; readonly retry: () => Promise<RestoreOutcome> };

const reloadPage = (): void => window.location.reload();

export interface RestoreConfirmProps {
  readonly view: Pick<NamedView, 'id' | 'name'>;
  /** Called when the dialog is done: cancelled, restored, or the draft was found changed elsewhere. */
  readonly onClose: () => void;
  readonly reload?: () => void;
}

/** The confirm of a restore (frame 64): the draft is replaced by the view, which stays as it is. */
export function RestoreConfirm({ view, onClose, reload = reloadPage }: RestoreConfirmProps) {
  const client = useApiClient();
  const state = useClientState();
  const [phase, setPhase] = useState<Phase>({ kind: 'asking' });
  const statusId = useId();
  const reading = useRef<AbortController | undefined>(undefined);
  // made as the confirm mounts, not before: a development build mounts, unmounts and mounts again, and the signal of the first mount must not outlive it
  useEffect(() => {
    const controller = new AbortController();
    reading.current = controller;
    return () => controller.abort();
  }, []);
  const busy = phase.kind === 'busy';

  const settle = (outcome: RestoreOutcome): void => {
    if (outcome.kind === 'restored' || outcome.kind === 'changed-elsewhere' || outcome.kind === 'left') {
      onClose();
      return;
    }
    setPhase(outcome.kind === 'failed' ? { kind: 'failed' } : { kind: 'read-failed', retry: outcome.retry });
  };
  const confirm = (): void => {
    if (busy) return;
    setPhase({ kind: 'busy' });
    void restoreNamedView(client, state, view.id, reading.current?.signal).then(settle);
  };
  const retry = (again: () => Promise<RestoreOutcome>): void => {
    setPhase({ kind: 'busy' });
    void again().then(settle);
  };
  const message = phase.kind === 'failed' ? RESTORE_FAILED : phase.kind === 'read-failed' ? RESTORE_READ_FAILED : phase.kind === 'busy' ? RESTORING : '';
  // a restore that reached the server must be seen through: the person chooses to read again or to reload
  const closable = phase.kind === 'asking' || phase.kind === 'failed';
  return (
    <Dialog title={RESTORE_TITLE} onClose={closable ? onClose : undefined} initialFocus="button.secondary">
      {() => (
        <div className="view-form" aria-describedby={statusId}>
          <p className="view-disclosure-plain">{restoreWarning(view.name)}</p>
          <p className="view-scope">{RESTORE_REASSURANCE}</p>
          <p id={statusId} role="status" className={phase.kind === 'failed' || phase.kind === 'read-failed' ? 'view-error' : 'visually-hidden'}>
            {message}
          </p>
          <div className="view-actions">
            {phase.kind === 'read-failed' ? (
              <>
                <button type="button" className="secondary" onClick={reload}>
                  {RELOAD}
                </button>
                <button type="button" className="primary" onClick={() => retry(phase.retry)}>
                  {TRY_AGAIN}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="secondary" disabled={busy} onClick={onClose}>
                  {CANCEL}
                </button>
                <button type="button" className="primary" disabled={busy} aria-busy={busy} onClick={confirm}>
                  {RESTORE_INTO_DRAFT}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
