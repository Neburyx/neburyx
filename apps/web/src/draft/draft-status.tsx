import { useEffect } from 'react';
import { useBanner } from '../banner/banner-context.js';
import { useStoreSelector } from '../state/store.js';
import { CHANGES_NOT_BEING_SAVED, CHANGES_NOT_SAVED, CHANGES_STILL_NOT_SAVED, CONFLICT_CHIP, CONFLICT_HEADLINE, CONFLICT_TEXT, DRAFT_CONFLICT_BANNER_ID, RELOAD, SAVE_AGAIN } from './copy.js';
import type { DraftStatus, DraftSync } from './draft-sync.js';

function textOf(status: DraftStatus): string {
  switch (status.kind) {
    case 'failing':
      return status.stalled ? CHANGES_STILL_NOT_SAVED : CHANGES_NOT_SAVED;
    case 'rejected':
      return CHANGES_NOT_BEING_SAVED;
    case 'conflict':
    case 'idle':
      return '';
  }
}

/** The one polite live region of the draft, kept out of sight: its text changes only when the state does, so a retry is never announced again. */
export function DraftAnnouncer({ sync }: { readonly sync: DraftSync }) {
  const status = useStoreSelector(sync.status, (current) => current);
  return (
    <div role="status" aria-live="polite" className="visually-hidden">
      {textOf(status)}
    </div>
  );
}

/** What the person sees of a draft that is not being saved, in the status strip; nothing while the draft is saved, or while the banner says why not. */
export function DraftStatusLine({ sync }: { readonly sync: DraftSync }) {
  const status = useStoreSelector(sync.status, (current) => current);
  if (status.kind === 'idle' || status.kind === 'conflict') return null;
  return (
    <p className="draft-status">
      {textOf(status)}
      {' '}
      <button type="button" className="secondary" onClick={() => sync.retry()}>
        {SAVE_AGAIN}
      </button>
    </p>
  );
}

const reloadPage = (): void => window.location.reload();

/** Shows the banner of an investigation that changed in another tab while the conflict stands; Reload loads the whole page again, which reads the latest draft. */
export function DraftConflictBanner({ sync, reload = reloadPage }: { readonly sync: DraftSync; readonly reload?: () => void }) {
  const status = useStoreSelector(sync.status, (current) => current.kind);
  const banner = useBanner();
  useEffect(() => {
    if (status !== 'conflict') return undefined;
    banner.show({
      id: DRAFT_CONFLICT_BANNER_ID,
      tone: 'warning',
      chip: CONFLICT_CHIP,
      headline: CONFLICT_HEADLINE,
      text: CONFLICT_TEXT,
      actions: [{ id: 'reload', label: RELOAD, run: reload }],
      dismissible: false,
      moveFocus: true,
    });
    return () => banner.dismiss(DRAFT_CONFLICT_BANNER_ID);
  }, [status, banner, reload]);
  return null;
}
