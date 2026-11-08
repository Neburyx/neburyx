import type { BannerController, BannerDescriber } from './banner-controller.js';
import type { BannerState } from './banner-state.js';
import { RATE_LIMITED_CHIP, RATE_LIMITED_TEXT, rateLimitedHeadline, rateLimitedRetry, rateLimitedSideLabel } from './copy.js';

export const RATE_LIMITED_BANNER_ID = 'rate-limited';

const TICK_MS = 1000;

/**
 * The Rate limited state: the wait the server gave, counting down, and a Retry that is held until the wait is over. A second rate-limited failure that arrives while the banner is shown
 * joins it, and the banner counts down the longest wait of those held; the one update that makes Retry available is announced. The countdown stops when the banner is dismissed or replaced. Returns the function that takes the cause out again.
 */
export function registerRateLimitedCause(controller: BannerController): () => void {
  let until = 0;
  let held: BannerState['actions'][number] | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const shown = (): boolean => controller.view.getState().banner?.id === RATE_LIMITED_BANNER_ID;

  const stateNow = (announce = false): BannerState => {
    const seconds = Math.ceil(Math.max(0, until - Date.now()) / 1000);
    return {
      id: RATE_LIMITED_BANNER_ID,
      tone: 'warning',
      chip: RATE_LIMITED_CHIP,
      headline: rateLimitedHeadline(seconds),
      text: RATE_LIMITED_TEXT,
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
    controller.show(stateNow(over));
    if (over) stop();
  };

  const unsubscribe = controller.view.subscribe(() => {
    if (timer !== undefined && !shown()) stop();
  });

  const describe: BannerDescriber = (failure, context) => {
    const wait = failure.details?.retryAfterMs;
    if (wait === undefined || !Number.isInteger(wait) || wait < 1) return undefined;
    until = Math.max(shown() ? until : 0, Date.now() + wait);
    held = context.retry(RATE_LIMITED_BANNER_ID, rateLimitedRetry(1));
    timer ??= setInterval(tick, TICK_MS);
    return stateNow();
  };

  const unregister = controller.registerCause('RATE_LIMITED', describe);
  return () => {
    stop();
    unsubscribe();
    unregister();
  };
}
