import type { BannerState } from './banner-state.js';
import { continueWith, HEAVY_CHIP, HEAVY_SIDE_LABEL, REFINE_FILTERS } from './copy.js';
import type { HeavyEstimate } from '../api/heavy-estimate.js';

export const HEAVY_BANNER_ID = 'heavy';

const WHOLE = new Intl.NumberFormat('en-US');

/** The estimate as the person reads it: exact as it is, "~" for an estimate, "≥" for a lower bound. */
export function estimateText(estimate: HeavyEstimate): string {
  const number = WHOLE.format(estimate.value);
  return estimate.quality === 'exact' ? number : estimate.quality === 'estimated' ? `~${number}` : `≥ ${number}`;
}

export interface HeavyBannerInput {
  readonly estimate: HeavyEstimate;
  readonly threshold: number;
  /** The bounded limit *Continue* sends. */
  readonly limit: number;
  /** How many selected nodes are waiting for the answer, the one held included; one for a single node. */
  readonly waiting: number;
  /** The limit is the page of each asked type, and the text says so when more than one type is asked. */
  readonly perType: boolean;
  readonly refine: () => void;
  readonly proceed: () => void;
}

/** The Heavy operation state: it tells the estimate and the threshold, never refuses, and names no node. */
export function heavyBannerState(input: HeavyBannerInput): BannerState {
  const waitingText = input.waiting > 1 ? ` ${input.waiting} selected nodes are waiting.` : '';
  return {
    id: HEAVY_BANNER_ID,
    tone: 'warning',
    chip: HEAVY_CHIP,
    headline: `Estimated ${estimateText(input.estimate)} matches · warning threshold ${WHOLE.format(input.threshold)}`,
    text: `Refine filters or continue with a bounded limit of ${input.limit}${input.perType ? ' per type' : ''}.${waitingText}`,
    sideLabel: HEAVY_SIDE_LABEL,
    actions: [
      { id: 'refine', label: REFINE_FILTERS, run: input.refine },
      { id: 'continue', label: continueWith(input.limit), run: input.proceed },
    ],
  };
}
