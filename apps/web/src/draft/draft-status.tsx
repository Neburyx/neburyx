import { useEffect, useRef } from 'react';
import { useApiClient } from '../api/client-context.js';
import { useClientState } from '../state/context.js';
import { draftSyncOf } from './draft-sync.js';
import { useBanner } from '../banner/banner-context.js';
import { useStoreSelector } from '../state/store.js';
import { CHANGES_NOT_BEING_SAVED, CHANGES_NOT_SAVED, CHANGES_STILL_NOT_SAVED, CONFLICT_CHIP, CONFLICT_HEADLINE, CONFLICT_TEXT, DRAFT_CONFLICT_BANNER_ID, LEAVE_ANYWAY, LEAVE_GUARD_LABEL, LEAVE_GUARD_TEXT, RELOAD, SAVE_AGAIN } from './copy.js';
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
      tone: 'caution',
      chip: CONFLICT_CHIP,
      headline: CONFLICT_HEADLINE,
      text: CONFLICT_TEXT,
      actions: [{ id: 'reload', label: RELOAD, run: reload, primary: true }],
      dismissible: false,
      moveFocus: true,
    });
    return () => banner.dismiss(DRAFT_CONFLICT_BANNER_ID);
  }, [status, banner, reload]);
  return null;
}

/**
 * What holds the person at the page they were about to leave when the changes to the investigation shown could not be written: on any page, so one reached from Home or from a search is covered as well. It takes the focus when it appears and is no live region of its own, since the draft's one polite region already says the changes are not saved.
 */
export function LeaveGuard() {
  const sync = draftSyncOf(useClientState(), useApiClient());
  const leaving = useStoreSelector(sync.leaving, (current) => current);
  const region = useRef<HTMLElement>(null);
  const before = useRef<Element | null>(null);
  useEffect(() => {
    if (leaving) {
      before.current = document.activeElement;
      region.current?.focus();
      return undefined;
    }
    // the guard went: focus returns to where it was, unless the page changed or that element is gone
    const back = before.current;
    before.current = null;
    if (back instanceof HTMLElement && back.isConnected && (document.activeElement === document.body || document.activeElement === null)) back.focus();
    return undefined;
  }, [leaving]);
  if (!leaving) return null;
  return (
    <section ref={region} tabIndex={-1} className="leave-guard" aria-label={LEAVE_GUARD_LABEL}>
      <p>{LEAVE_GUARD_TEXT}</p>
      <button type="button" className="primary" onClick={() => sync.retry()}>
        {SAVE_AGAIN}
      </button>
      <button type="button" className="secondary" onClick={() => sync.leaveAnyway()}>
        {LEAVE_ANYWAY}
      </button>
    </section>
  );
}
