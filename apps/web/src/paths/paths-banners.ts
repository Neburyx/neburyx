import type { BannerState } from '../banner/banner-state.js';
import { PARTIAL_CHIP, PARTIAL_TEXT } from '../banner/copy.js';
import { reviewLabel } from './copy.js';

export const PARTIAL_BANNER_ID = 'partial';

export interface PartialBannerInput {
  /** The limit that stopped the search, as "5 s timeout"; left out when the source's timeout is not known. */
  readonly reason: string | undefined;
  readonly retained: number;
  readonly requested: number;
  readonly review: () => void;
}

/**
 * The Partial state of frame 15 for a path search that timed out after it found some paths. It is built from the answer's counts, not from the partial-result error, whose details cannot say that the limit was
 * read before the time ran out (`retained` equal to `requested`); the words are the same as that cause's.
 */
export function partialBannerState(input: PartialBannerInput): BannerState {
  return {
    id: PARTIAL_BANNER_ID,
    tone: 'warning',
    chip: PARTIAL_CHIP,
    headline: `${input.reason === undefined ? '' : `${input.reason} · `}${input.retained} of ${input.requested} requested paths retained`,
    text: PARTIAL_TEXT,
    sideLabel: `${input.retained} / ${input.requested} paths retained`,
    actions: [{ id: 'review', label: reviewLabel(input.retained), run: input.review }],
  };
}
