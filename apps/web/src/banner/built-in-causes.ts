import { partialDetailsSchema } from '@neburyx/contracts';
import { createBannerController, type BannerController, type BannerDescriber } from './banner-controller.js';
import { registerRateLimitedCause } from './rate-limited-cause.js';
import { registerSourceUnavailableCause } from './source-unavailable-cause.js';
import { BUSY_CHIP, BUSY_SIDE_LABEL, BUSY_TEXT, busyHeadline, PARTIAL_CHIP, PARTIAL_TEXT, RETRY, TIMED_OUT_CHIP, TIMED_OUT_SIDE_LABEL, TIMED_OUT_TEXT, timedOutHeadline } from './copy.js';

export const PARTIAL_BANNER_ID = 'partial';
export const BUSY_BANNER_ID = 'busy';
export const TIMED_OUT_BANNER_ID = 'timed-out';

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

/** The source did not answer within the limit that stopped the request, and nothing was merged. A failure that names no limit, or a state with no source name, builds nothing: the banner never states a number it was not given. */
export const describeTimedOut: BannerDescriber = (failure, context) => {
  const limit = failure.details?.timeoutMs;
  if (context.source === undefined || context.source.trim() === '' || limit === undefined || !Number.isInteger(limit) || limit < 1) return undefined;
  const retry = context.retry(TIMED_OUT_BANNER_ID, RETRY);
  return {
    id: TIMED_OUT_BANNER_ID,
    tone: 'warning',
    chip: TIMED_OUT_CHIP,
    headline: timedOutHeadline(context.source, limit),
    text: TIMED_OUT_TEXT,
    sideLabel: TIMED_OUT_SIDE_LABEL,
    actions: retry === undefined ? [] : [retry],
  };
};

export function registerBuiltInBannerCauses(controller: BannerController): void {
  controller.registerCause('PARTIAL_RESULT', describePartial);
  controller.registerCause('SOURCE_BUSY', describeBusy);
  controller.registerCause('QUERY_TIMEOUT', describeTimedOut);
  registerRateLimitedCause(controller);
  registerSourceUnavailableCause(controller);
}

export function createBuiltInBannerController(): BannerController {
  const controller = createBannerController();
  registerBuiltInBannerCauses(controller);
  return controller;
}
