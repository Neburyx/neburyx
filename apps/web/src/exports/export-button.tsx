import { useId, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { useBanner } from '../banner/banner-context.js';
import { exportBlockedOf } from '../state/investigation-state.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { DONE_ANNOUNCEMENT, EXPORT_BUTTON, EXPORT_DISABLED_SOURCE } from './copy.js';
import { ExportDialog } from './export-dialog.js';
import { showDownloadRefused } from './refused-banner.js';

/** The Export button of the header: it stays available for a closed or an archived investigation, since an export changes nothing, and is dimmed with its reason when the source changed, since an export reads the source. */
export function ExportButton({ client }: { readonly client: ApiClient }) {
  const state = useClientState();
  const banner = useBanner();
  const investigationId = useStoreSelector(state.investigation, (held) => held.id);
  const blocked = useStoreSelector(state.investigation, (held) => exportBlockedOf(held.record));
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = (): void => {
    setOpen(false);
    queueMicrotask(() => button.current?.focus());
  };
  return (
    <>
      <button ref={button} type="button" className="secondary" disabled={investigationId === null || blocked} title={blocked ? EXPORT_DISABLED_SOURCE : undefined} aria-describedby={blocked ? reasonId : undefined} aria-haspopup="dialog" onClick={() => {
          setDone(false);
          setOpen(true);
        }}>
        {EXPORT_BUTTON}
      </button>
      {blocked ? (
        <span id={reasonId} className="visually-hidden">
          {EXPORT_DISABLED_SOURCE}
        </span>
      ) : null}
      <span role="status" className="visually-hidden">
        {done ? DONE_ANNOUNCEMENT : ''}
      </span>
      {open && !blocked ? <ExportDialog client={client} onClose={close} onDone={() => setDone(true)} onAccessChanged={() => showDownloadRefused(banner, () => setOpen(true))} /> : null}
    </>
  );
}
