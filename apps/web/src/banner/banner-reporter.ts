import type { ErrorCode } from '@neburyx/contracts';
import type { FailureReporter } from '../api/failure-reporter.js';
import type { BannerController } from './banner-controller.js';

interface Held {
  readonly code: ErrorCode;
  readonly bannerId: string;
  readonly resends: (() => void)[];
}

/**
 * Shows a server failure on the banner when a cause is registered for its code, naming the source by its display name; a failure the client made itself is never shown there.
 * A failure of the same code that arrives while its banner is still shown joins it: the banner's one Retry sends each held request again once, in the order they failed.
 */
export function bannerReporter(banner: BannerController, sourceName: (sourceId: string) => string): FailureReporter {
  let held: Held | undefined;
  banner.view.subscribe(() => {
    if (held !== undefined && banner.view.getState().banner?.id !== held.bannerId) held = undefined;
  });
  return (failure, sourceId, resend) => {
    if (!('traceId' in failure)) return false;
    const joins = held !== undefined && held.code === failure.code && banner.view.getState().banner?.id === held.bannerId;
    const resends = joins && held !== undefined ? [...held.resends, resend] : [resend];
    const shown = banner.showFailure(failure, { resend: () => resends.forEach((each) => each()), source: sourceName(sourceId) });
    const bannerId = banner.view.getState().banner?.id;
    held = shown && bannerId !== undefined ? { code: failure.code, bannerId, resends } : undefined;
    return shown;
  };
}
