import { useState } from 'react';
import type { AssistantThreadClearResponse } from '@neburyx/contracts';
import { isServerFailure, type ApiResult } from '../api/client.js';
import { ConfirmDialog } from '../lifecycle/confirm-dialog.js';
import { ASSISTANT_COPY } from './copy.js';
import { isAccessLost } from './stored-thread.js';

export interface ClearChatDialogProps {
  /** Sends the clear call; the caller decides what must settle first. */
  readonly send: () => Promise<ApiResult<AssistantThreadClearResponse>>;
  /** The thread was deleted (or there was none): the caller shows the empty thread. */
  readonly onCleared: () => void;
  /** The server says the investigation or its source is no longer the person's, judged as a read of the thread judges it. */
  readonly onAccessLost: () => void;
  readonly onClose: () => void;
}

/** The confirmation that asks before a chat is cleared. Nothing on screen changes on a failure other than lost access: the dialog stays with a fixed line, and while the call is out nothing dismisses it. */
export function ClearChatDialog({ send, onCleared, onAccessLost, onClose }: ClearChatDialogProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<'refused' | 'unconfirmed' | undefined>(undefined);

  const confirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailed(undefined);
    const result = await send();
    if (!result.ok) {
      if (isAccessLost(result.failure)) {
        onAccessLost();
        return;
      }
      setBusy(false);
      // an answer of the server says nothing was deleted (the clearing is one transaction); a lost response, a timeout or a failure of the client leaves what the server did unknown
      setFailed(isServerFailure(result.failure) ? 'refused' : 'unconfirmed');
      return;
    }
    onCleared();
  };

  return (
    <ConfirmDialog
      title={ASSISTANT_COPY.clearTitle}
      confirmLabel={ASSISTANT_COPY.clearChat}
      busyLabel={ASSISTANT_COPY.clearing}
      busy={busy}
      canConfirm
      initialFocus="cancel"
      lockWhileBusy
      closeOnScrim
      hideClose
      scrimClassName="clear-chat-scrim"
      dialogClassName="clear-chat-dialog confirm-dialog"
      message={failed === 'refused' ? ASSISTANT_COPY.clearRefused : failed === 'unconfirmed' ? ASSISTANT_COPY.clearFailed : undefined}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      <p className="clear-chat-body">{ASSISTANT_COPY.clearBody}</p>
      <p className="clear-chat-warning">{ASSISTANT_COPY.clearWarning}</p>
    </ConfirmDialog>
  );
}
