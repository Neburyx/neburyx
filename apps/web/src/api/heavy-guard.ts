import type { ElementRef } from '@neburyx/contracts';
import type { BannerController } from '../banner/banner-controller.js';
import { HEAVY_BANNER_ID, heavyBannerState } from '../banner/heavy-banner.js';
import type { ClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { heavyDecision, type EstimateAsk, type HeavyDecision } from './heavy-estimate.js';
import type { PreviewStore } from './preview-store.js';

type Heavy = Extract<HeavyDecision, { kind: 'heavy' }>;

/** What the expand store hands over when an ask is held: the decision, the limit *Continue* sends, how many selected nodes wait, and the two things the person can choose. */
export interface HeavyHold {
  readonly ref: ElementRef;
  readonly decision: Heavy;
  readonly limit: number;
  /** How many neighbor types the ask names: the limit is the page of each. */
  readonly types: number;
  readonly waiting: number;
  /** Sends the ask again, bounded; does nothing once the ask belongs to another investigation or masking. */
  readonly proceed: () => void;
}

/** The check the expand store makes before the first page of a type, and what it shows when the estimate is over the threshold. */
export interface HeavyGuard {
  /** Decides from the preview the node has, asking for it when none is held; `none` when the preview cannot be had. */
  decide(ask: EstimateAsk, mask: boolean): Promise<HeavyDecision>;
  hold(held: HeavyHold): void;
  /** Takes the warning down when a newer ask for its node starts, so a Continue that no longer matches cannot be pressed. */
  release(ref: ElementRef): void;
}

export function createHeavyGuard(previews: PreviewStore, banner: BannerController, state: ClientState): HeavyGuard {
  let shownFor: string | undefined;
  return {
    release(ref) {
      if (shownFor !== elementKey(ref)) return;
      shownFor = undefined;
      banner.dismiss(HEAVY_BANNER_ID);
    },
    async decide(ask, mask) {
      const preview = previews.held(ask.ref, mask) ?? (await previews.settle(ask.ref, mask));
      return preview === undefined ? { kind: 'none' } : heavyDecision(preview, ask);
    },
    hold(held) {
      const key = elementKey(held.ref);
      shownFor = key;
      banner.show(
        heavyBannerState({
          estimate: held.decision.estimate,
          threshold: held.decision.threshold,
          limit: held.limit,
          waiting: held.waiting,
          perType: held.types > 1,
          refine: () => {
            shownFor = undefined;
            banner.dismiss(HEAVY_BANNER_ID);
            // a panel opened for one type stays about that type, so the next Load is no wider than the ask that was warned about
            const open = state.presentation.view.getState().supernodePanel;
            state.presentation.setSupernodePanel({ key, ...(open?.key === key && open.neighborType !== undefined ? { neighborType: open.neighborType } : {}) });
          },
          proceed: () => {
            shownFor = undefined;
            banner.dismiss(HEAVY_BANNER_ID);
            held.proceed();
          },
        }),
      );
    },
  };
}
