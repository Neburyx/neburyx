import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { useBanner } from '../banner/banner-context.js';
import { BANNER_REGION_CLASS } from '../banner/status-banner.js';
import type { BannerState } from '../banner/banner-state.js';
import { useClientState } from '../state/context.js';
import { isSourceChanged, type InvestigationStatus } from '../state/investigation-state.js';
import { useStoreSelector } from '../state/store.js';
import {
  ARCHIVED_CHIP, ARCHIVED_HEADLINE, ARCHIVED_TEXT, CLOSED_CHIP, CLOSED_HEADLINE, CLOSED_TEXT, DELETE, REMOVED_CHIP, REMOVED_DELETE_SENTENCE, REMOVED_HEADLINE, REMOVED_TEXT, REOPEN, REPOINTED_CHIP, REPOINTED_HEADLINE, REPOINTED_TEXT, STANDING_BANNER_ID,
} from './copy.js';
import { WorkspaceDeleteDialog } from './investigation-menu.js';
import { changeStatus, statusChangeBusy } from './status-flow.js';

function standingBannerOf(status: Exclude<InvestigationStatus, 'open'>, reopen: BannerState['actions']): BannerState {
  return status === 'closed'
    ? { id: STANDING_BANNER_ID, tone: 'neutral', chip: CLOSED_CHIP, headline: CLOSED_HEADLINE, text: CLOSED_TEXT, actions: reopen, dismissible: false }
    : { id: STANDING_BANNER_ID, tone: 'neutral', chip: ARCHIVED_CHIP, headline: ARCHIVED_HEADLINE, text: ARCHIVED_TEXT, actions: [], dismissible: false };
}

/** The banner of a source that was re-pointed or removed (frames 60 and 61); only the owner is offered Delete, and only a removed source says so. */
function sourceChangedBannerOf(sourceState: 'repointed' | 'removed', canDelete: boolean, onDelete: () => void, busy: boolean): BannerState {
  if (sourceState === 'repointed') return { id: STANDING_BANNER_ID, tone: 'neutral', chip: REPOINTED_CHIP, headline: REPOINTED_HEADLINE, text: REPOINTED_TEXT, actions: [], dismissible: false };
  return {
    id: STANDING_BANNER_ID,
    tone: 'neutral',
    chip: REMOVED_CHIP,
    headline: REMOVED_HEADLINE,
    text: canDelete ? `${REMOVED_TEXT} ${REMOVED_DELETE_SENTENCE}` : REMOVED_TEXT,
    actions: canDelete ? [{ id: 'delete', label: DELETE, disabled: busy, run: onDelete }] : [],
    dismissible: false,
  };
}

/**
 * Keeps the banner of an investigation that cannot be changed up as long as it cannot, under any banner of a request; draws only the confirm that Delete asks. A changed source is the cause shown first, since an operator must act on it,
 * and the closed or archived banner returns once the source is as it was.
 */
export function ReadOnlyBannerSync({ client }: { readonly client: ApiClient }) {
  const state = useClientState();
  const banner = useBanner();
  const status = useStoreSelector(state.investigation, (held) => held.record?.status);
  const sourceState = useStoreSelector(state.investigation, (held) => held.record?.sourceState);
  const canDelete = useStoreSelector(state.investigation, (held) => held.record?.canDelete !== false);
  const busy = useStoreSelector(statusChangeBusy(state), (value) => value);
  const [deleting, setDeleting] = useState(false);
  const previous = useRef<string | undefined>(undefined);
  // the confirm of Delete returns focus to the banner's Delete once it is gone, as the menu's dialogs return it to the menu button
  const refocus = useRef(false);
  useEffect(() => {
    if (deleting || !refocus.current) return;
    refocus.current = false;
    queueMicrotask(() => [...document.querySelectorAll<HTMLButtonElement>(`.${BANNER_REGION_CLASS} button`)].find((button) => button.textContent === DELETE)?.focus());
  }, [deleting]);
  // whether this component holds the standing slot, so that an open investigation does not clear a banner another feature put there
  const holds = useRef(false);
  useEffect(() => {
    const changed = sourceState !== undefined && sourceState !== 'available' ? sourceState : undefined;
    const cause = changed ?? (status === undefined || status === 'open' ? undefined : status);
    if (cause === undefined) {
      if (holds.current) banner.setStanding(undefined);
      holds.current = false;
      previous.current = undefined;
      return;
    }
    const announce = previous.current !== undefined && previous.current !== cause;
    previous.current = cause;
    holds.current = true;
    if (changed !== undefined) {
      banner.setStanding({ ...sourceChangedBannerOf(changed, canDelete, () => setDeleting(true), busy), ...(announce ? { announce: true } : {}) });
      return;
    }
    const reopen = [{ id: 'reopen', label: REOPEN, disabled: busy, primary: true, run: () => void changeStatus({ client, state, banner }, 'open') }];
    banner.setStanding({ ...standingBannerOf(cause as Exclude<InvestigationStatus, 'open'>, reopen), ...(announce ? { announce: true } : {}) });
  }, [banner, canDelete, client, state, status, sourceState, busy]);
  useEffect(() => () => { if (holds.current) banner.setStanding(undefined); }, [banner]);
  return deleting && isSourceChanged(sourceState) ? <WorkspaceDeleteDialog client={client} onClose={() => { refocus.current = true; setDeleting(false); }} /> : null;
}
