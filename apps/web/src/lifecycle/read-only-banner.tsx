import { useEffect, useRef } from 'react';
import type { ApiClient } from '../api/client.js';
import { useBanner } from '../banner/banner-context.js';
import type { BannerState } from '../banner/banner-state.js';
import { useClientState } from '../state/context.js';
import type { InvestigationStatus } from '../state/investigation-state.js';
import { useStoreSelector } from '../state/store.js';
import { ARCHIVED_CHIP, ARCHIVED_HEADLINE, ARCHIVED_TEXT, CLOSED_CHIP, CLOSED_HEADLINE, CLOSED_TEXT, REOPEN, STANDING_BANNER_ID } from './copy.js';
import { changeStatus, statusChangeBusy } from './status-flow.js';

function standingBannerOf(status: Exclude<InvestigationStatus, 'open'>, reopen: BannerState['actions']): BannerState {
  return status === 'closed'
    ? { id: STANDING_BANNER_ID, tone: 'neutral', chip: CLOSED_CHIP, headline: CLOSED_HEADLINE, text: CLOSED_TEXT, actions: reopen, dismissible: false }
    : { id: STANDING_BANNER_ID, tone: 'neutral', chip: ARCHIVED_CHIP, headline: ARCHIVED_HEADLINE, text: ARCHIVED_TEXT, actions: [], dismissible: false };
}

/** Keeps the banner of a closed or archived investigation up as long as it is, under any banner of a request; draws nothing. */
export function ReadOnlyBannerSync({ client }: { readonly client: ApiClient }) {
  const state = useClientState();
  const banner = useBanner();
  const status = useStoreSelector(state.investigation, (held) => held.record?.status);
  const busy = useStoreSelector(statusChangeBusy(state), (value) => value);
  const previous = useRef<typeof status>(undefined);
  useEffect(() => {
    if (status === undefined || status === 'open') {
      banner.setStanding(undefined);
      return;
    }
    const reopen = [{ id: 'reopen', label: REOPEN, disabled: busy, primary: true, run: () => void changeStatus({ client, state, banner }, 'open') }];
    const changed = previous.current !== undefined && previous.current !== status;
    previous.current = status;
    banner.setStanding({ ...standingBannerOf(status, reopen), ...(changed ? { announce: true } : {}) });
  }, [banner, client, state, status, busy]);
  useEffect(() => () => banner.setStanding(undefined), [banner]);
  return null;
}
