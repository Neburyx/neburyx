import { useState } from 'react';
import type { AssistantThreadClearResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { ConfirmDialog } from '../lifecycle/confirm-dialog.js';
import { ASSISTANT_COPY } from './copy.js';

export interface ClearChatDialogProps {
  /** Sends the clear call; the caller decides what must settle first. */
  readonly send: () => Promise<ApiResult<AssistantThreadClearResponse>>;
  /** The thread was deleted (or there was none): the caller shows the empty thread. */
  readonly onCleared: () => void;
  readonly onClose: () => void;
}

/** The confirmation that asks before a chat is cleared. Nothing on screen changes on a failure: the dialog stays with a fixed line, and while the call is out nothing dismisses it. */
export function ClearChatDialog({ send, onCleared, onClose }: ClearChatDialogProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const result = await send();
    if (!result.ok) {
      setBusy(false);
      setFailed(true);
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
      message={failed ? ASSISTANT_COPY.clearFailed : undefined}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      <p className="clear-chat-body">{ASSISTANT_COPY.clearBody}</p>
      <p className="clear-chat-warning">{ASSISTANT_COPY.clearWarning}</p>
    </ConfirmDialog>
  );
}
