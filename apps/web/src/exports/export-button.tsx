import { useRef, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { useBanner } from '../banner/banner-context.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { DONE_ANNOUNCEMENT, EXPORT_BUTTON } from './copy.js';
import { ExportDialog } from './export-dialog.js';
import { showDownloadRefused } from './refused-banner.js';

/** The Export button of the header: it stays available for a closed or an archived investigation, since an export changes nothing. */
export function ExportButton({ client }: { readonly client: ApiClient }) {
  const state = useClientState();
  const banner = useBanner();
  const investigationId = useStoreSelector(state.investigation, (held) => held.id);
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = (): void => {
    setOpen(false);
    queueMicrotask(() => button.current?.focus());
  };
  return (
    <>
      <button ref={button} type="button" className="secondary" disabled={investigationId === null} aria-haspopup="dialog" onClick={() => {
          setDone(false);
          setOpen(true);
        }}>
        {EXPORT_BUTTON}
      </button>
      <span role="status" className="visually-hidden">
        {done ? DONE_ANNOUNCEMENT : ''}
      </span>
      {open ? <ExportDialog client={client} onClose={close} onDone={() => setDone(true)} onAccessChanged={() => showDownloadRefused(banner, () => setOpen(true))} /> : null}
    </>
  );
}
