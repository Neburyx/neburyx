import { partialDetailsSchema } from '@neburyx/contracts';
import { createBannerController, type BannerController, type BannerDescriber } from './banner-controller.js';
import { BUSY_CHIP, BUSY_SIDE_LABEL, BUSY_TEXT, busyHeadline, PARTIAL_CHIP, PARTIAL_TEXT, RETRY } from './copy.js';

export const PARTIAL_BANNER_ID = 'partial';
export const BUSY_BANNER_ID = 'busy';

export const describePartial: BannerDescriber = (failure, context) => {
  const { partial } = context;
  const counts = partialDetailsSchema.safeParse(failure.details);
  if (partial === undefined || partial.itemNoun.trim() === '' || !counts.success) return undefined;
  const { retained, requested } = counts.data;
  const { itemNoun, reason, review } = partial;
  return {
    id: PARTIAL_BANNER_ID,
    tone: 'warning',
    chip: PARTIAL_CHIP,
    headline: `${reason === undefined ? '' : `${reason} · `}${retained} of ${requested} requested ${itemNoun} retained`,
    text: PARTIAL_TEXT,
    sideLabel: `${retained} / ${requested} ${itemNoun} retained`,
    actions: review === undefined ? [] : [{ id: 'review', label: review.label, run: review.run }],
  };
};

/** No read slot freed within the wait: nothing was read, and Retry sends the same request again. A state with no source name to give says nothing rather than guess one. */
export const describeBusy: BannerDescriber = (_failure, context) => {
  if (context.source === undefined || context.source.trim() === '') return undefined;
  const retry = context.retry(BUSY_BANNER_ID, RETRY);
  return {
    id: BUSY_BANNER_ID,
    tone: 'warning',
    chip: BUSY_CHIP,
    headline: busyHeadline(context.source),
    text: BUSY_TEXT,
    sideLabel: BUSY_SIDE_LABEL,
    actions: retry === undefined ? [] : [retry],
  };
};

export function registerBuiltInBannerCauses(controller: BannerController): void {
  controller.registerCause('PARTIAL_RESULT', describePartial);
  controller.registerCause('SOURCE_BUSY', describeBusy);
}

export function createBuiltInBannerController(): BannerController {
  const controller = createBannerController();
  registerBuiltInBannerCauses(controller);
  return controller;
}
