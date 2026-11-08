import type { BannerController, BannerDescriber } from './banner-controller.js';
import type { BannerState } from './banner-state.js';
import { RETRY, rateLimitedRetry, rateLimitedSideLabel, REPEATED_TIMEOUTS_CHIP, repeatedTimeoutsHeadline, UNAVAILABLE_CHIP, UNAVAILABLE_SIDE_LABEL, UNAVAILABLE_TEXT, unavailableHeadline } from './copy.js';

export const SOURCE_UNAVAILABLE_BANNER_ID = 'source-unavailable';

const TICK_MS = 1000;

/**
 * The Source unavailable state, for a failure the server calls retryable: the loaded graph stays, and Retry sends the request again. After repeated timeouts the server also gives the wait; the banner
 * says so and counts it down, and Retry is held until it is over. Without a usable wait there is no countdown and no number. Any other reason (not retryable, or an index that is not ready) builds nothing, so the failure is shown as before.
 * Returns the function that takes the cause out again.
 */
export function registerSourceUnavailableCause(controller: BannerController): () => void {
  let until = 0;
  let held: BannerState['actions'][number] | undefined;
  let source = '';
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const shown = (): boolean => controller.view.getState().banner?.id === SOURCE_UNAVAILABLE_BANNER_ID;

  const waiting = (announce = false): BannerState => {
    const seconds = Math.ceil(Math.max(0, until - Date.now()) / 1000);
    return {
      id: SOURCE_UNAVAILABLE_BANNER_ID,
      tone: 'danger',
      chip: REPEATED_TIMEOUTS_CHIP,
      headline: repeatedTimeoutsHeadline(source),
      text: seconds > 0 ? UNAVAILABLE_TEXT : `${UNAVAILABLE_TEXT} You can retry now.`,
      sideLabel: rateLimitedSideLabel(seconds),
      actions: held === undefined ? [] : [{ ...held, label: rateLimitedRetry(seconds), disabled: seconds > 0 }],
      ...(announce ? { announce: true } : {}),
    };
  };

  const tick = (): void => {
    if (!shown()) {
      stop();
      return;
    }
    const over = until - Date.now() <= 0;
    controller.show(waiting(over));
    if (over) stop();
  };

  const unsubscribe = controller.view.subscribe(() => {
    if (timer !== undefined && !shown()) stop();
  });

  const describe: BannerDescriber = (failure, context) => {
    const reason = failure.details?.reason ?? 'unreachable';
    if (!failure.retryable || (reason !== 'unreachable' && reason !== 'repeated-timeouts') || context.source === undefined || context.source.trim() === '') return undefined;
    source = context.source;
    held = context.retry(SOURCE_UNAVAILABLE_BANNER_ID, RETRY);
    const wait = failure.details?.retryAfterMs;
    if (reason === 'repeated-timeouts' && wait !== undefined && Number.isInteger(wait) && wait >= 1) {
      until = Date.now() + wait;
      stop();
      timer = setInterval(tick, TICK_MS);
      return waiting();
    }
    stop();
    return {
      id: SOURCE_UNAVAILABLE_BANNER_ID,
      tone: 'danger',
      chip: reason === 'repeated-timeouts' ? REPEATED_TIMEOUTS_CHIP : UNAVAILABLE_CHIP,
      headline: reason === 'repeated-timeouts' ? repeatedTimeoutsHeadline(source) : unavailableHeadline(source),
      text: UNAVAILABLE_TEXT,
      sideLabel: UNAVAILABLE_SIDE_LABEL,
      actions: held === undefined ? [] : [held],
    };
  };

  const unregister = controller.registerCause('SOURCE_UNAVAILABLE', describe);
  return () => {
    stop();
    unsubscribe();
    unregister();
  };
}
