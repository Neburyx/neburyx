import { useId, useRef, useState } from 'react';
import { SAVE_DISABLED, SAVE_DISABLED_SOURCE } from '../lifecycle/copy.js';
import { isSourceChanged } from '../state/investigation-state.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { SAVE_CONTROL } from './copy.js';
import { SaveDialog } from './save-dialog.js';

/** The Save control of the header: it opens the Save investigation dialog, and the focus returns to it when the dialog closes. */
export function SaveControl() {
  const record = useStoreSelector(useClientState().investigation, (current) => current.record);
  const shown = record !== null;
  const readOnly = record?.readOnly === true;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  if (!shown) return null;
  // a changed source is the cause an operator must act on, so it is the reason given before a closed or archived status
  const reason = !readOnly ? undefined : isSourceChanged(record.sourceState) ? SAVE_DISABLED_SOURCE : SAVE_DISABLED;
  return (
    <>
      <button type="button" ref={button} className="primary header-save" aria-haspopup="dialog" disabled={readOnly} title={reason} aria-describedby={reason === undefined ? undefined : reasonId} onClick={() => setOpen(true)}>
        {SAVE_CONTROL}
      </button>
      {reason === undefined ? null : (
        <span id={reasonId} className="visually-hidden">
          {reason}
        </span>
      )}
      {open && !readOnly ? <SaveDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
