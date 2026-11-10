import { useRef, useState } from 'react';
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
  if (!shown) return null;
  return (
    <>
      <button type="button" ref={button} className="primary header-save" aria-haspopup="dialog" disabled={readOnly} onClick={() => setOpen(true)}>
        {SAVE_CONTROL}
      </button>
      {open && !readOnly ? <SaveDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
