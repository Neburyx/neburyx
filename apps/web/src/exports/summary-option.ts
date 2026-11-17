import { SUMMARY_TOKEN_LIFETIME_MS } from '@neburyx/contracts';
import { useEffect, useRef, useState } from 'react';
import { useAiAvailabilityWhenProvided } from '../shell/shell-data.js';
import { useClientState } from '../state/context.js';
import { createStore, useStoreSelector } from '../state/store.js';
import { editedOf } from '../summary/summary-model.js';
import { EMPTY_SUMMARY_SESSION, summarySessionOf } from '../summary/summary-session.js';
import { SUMMARY_EDITED, SUMMARY_EXPIRED, SUMMARY_NOT_FOR_PICTURE, SUMMARY_NO_DRAFT, type PictureFormat } from './copy.js';

const NO_SESSION = createStore(EMPTY_SUMMARY_SESSION);

/** What the export dialog offers of the summary: nothing (Community), the option with the reason it is off, or the option with the token it would send. */
export type SummaryOption = { readonly kind: 'hidden' } | { readonly kind: 'disabled'; readonly reason: string } | { readonly kind: 'offered'; readonly token: string };

/**
 * The option of the dialog for the draft on screen: offered while an unedited draft of this investigation has a token that has not run out (timed here from the draft's arrival; the server's refusal is the backstop for any skew),
 * and never for a picture. It holds no text of the summary, only the token string the draft carried.
 */
export function useSummaryOption(format: PictureFormat, now: () => number = Date.now): SummaryOption {
  const state = useClientState();
  const available = useAiAvailabilityWhenProvided('summary') === 'available';
  const session = useStoreSelector(summarySessionOf(state) ?? NO_SESSION, (held) => held);
  const investigationId = useStoreSelector(state.investigation, (held) => held.id);
  const arrivedAt = session.draft?.arrivedAt;
  const [, tick] = useState(0);
  const clock = useRef(now);
  clock.current = now;
  useEffect(() => {
    if (arrivedAt === undefined) return;
    const left = arrivedAt + SUMMARY_TOKEN_LIFETIME_MS - clock.current();
    if (left <= 0) return;
    const timer = setTimeout(() => tick((count) => count + 1), left + 5);
    return () => clearTimeout(timer);
  }, [arrivedAt]);
  if (!available) return { kind: 'hidden' };
  const { draft } = session;
  if (draft === undefined || session.investigationId !== investigationId || investigationId === null) return { kind: 'disabled', reason: SUMMARY_NO_DRAFT };
  if (format === 'png') return { kind: 'disabled', reason: SUMMARY_NOT_FOR_PICTURE };
  if (editedOf(draft)) return { kind: 'disabled', reason: SUMMARY_EDITED };
  if (now() - draft.arrivedAt >= SUMMARY_TOKEN_LIFETIME_MS) return { kind: 'disabled', reason: SUMMARY_EXPIRED };
  return { kind: 'offered', token: draft.response.summaryToken };
}
