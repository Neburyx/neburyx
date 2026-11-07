import { partialDetailsSchema } from '@neburyx/contracts';
import { createBannerController, type BannerController, type BannerDescriber } from './banner-controller.js';
import { PARTIAL_CHIP, PARTIAL_TEXT } from './copy.js';

export const PARTIAL_BANNER_ID = 'partial';

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

export function registerBuiltInBannerCauses(controller: BannerController): void {
  controller.registerCause('PARTIAL_RESULT', describePartial);
}

export function createBuiltInBannerController(): BannerController {
  const controller = createBannerController();
  registerBuiltInBannerCauses(controller);
  return controller;
}
