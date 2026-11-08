export const BANNER_LABEL = 'Request status';
export const DISMISS = 'Dismiss';
export const PARTIAL_CHIP = 'Partial';
export const PARTIAL_TEXT = 'Partial, not exhaustive · graph preserved.';
export const BUSY_CHIP = 'Busy';
export const busyHeadline = (source: string): string => `${source} is busy. No read slot freed within the wait.`;
export const BUSY_TEXT = 'Loaded graph and filters preserved; nothing was read. Retry when ready.';
export const BUSY_SIDE_LABEL = 'No read slot freed';
export const RETRY = 'Retry';
export const TIMED_OUT_CHIP = 'Timed out';
export const TIMED_OUT_TEXT = 'Loaded graph and filters preserved; nothing was merged. Retry when ready.';
export const TIMED_OUT_SIDE_LABEL = 'Nothing merged';
export const HEAVY_CHIP = 'Heavy operation';
export const HEAVY_SIDE_LABEL = 'Estimated matches';
export const REFINE_FILTERS = 'Refine filters';
export const continueWith = (limit: number): string => `Continue with ${limit}`;
export const RATE_LIMITED_CHIP = 'Rate limited';
export const rateLimitedHeadline = (seconds: number): string => (seconds > 0 ? `Too many requests. Retry after ${seconds} s.` : 'Too many requests. You can retry now.');
export const RATE_LIMITED_TEXT = 'Loaded graph and filters preserved; nothing was read. The wait is set by the server.';
export const rateLimitedSideLabel = (seconds: number): string => (seconds > 0 ? `Retry after ${seconds} s` : 'Retry now');
export const rateLimitedRetry = (seconds: number): string => (seconds > 0 ? `Retry in ${seconds} s` : RETRY);
export const RUNNING_CHIP = 'Running';
export const RUNNING_TEXT = 'Loaded graph and filters preserved.';
export const CANCELLED_CHIP = 'Cancelled';
export const CANCELLED_TEXT = 'Loaded graph and filters preserved; no complete-result claim.';
export const CANCELLED_SIDE_LABEL = '0 new relationships added';
export const PREVIEW_CANCELLED_SIDE_LABEL = 'Nothing added';
export const PREVIEW_CANCELLED_HEADLINE = 'Cancelled. Nothing was added to the graph.';
export const RUN_AGAIN = 'Run again';
export const cancelledHeadline = (): string => 'Cancelled. No new relationships added.';

export type RequestKind = 'expand' | 'more' | 'start-over' | 'preview';

const elapsedSeconds = (ms: number): string => (Math.round(ms / 100) / 10).toFixed(1);
const limitSeconds = (ms: number): string => String(Math.round(ms / 100) / 10);
export const timedOutHeadline = (source: string, limitMs: number): string => `${source} did not answer within ${limitSeconds(limitMs)} s.`;

const whatRuns = (kind: RequestKind, title: string | undefined): string => {
  const of = title === undefined ? '' : ` ${title}`;
  switch (kind) {
    case 'expand':
      return `Expanding${of === '' ? ' relationships' : of}`;
    case 'more':
      return `Loading more relationships${title === undefined ? '' : ` of ${title}`}`;
    case 'start-over':
      return `Starting over${of === '' ? ' an expansion' : of}`;
    case 'preview':
      return `Counting relationships${title === undefined ? '' : ` of ${title}`}`;
    default:
      return 'Running';
  }
};
export const runningHeadline = (kind: RequestKind, title: string | undefined, elapsedMs: number, limitMs: number | undefined): string =>
  `${whatRuns(kind, title)} · ${elapsedSeconds(elapsedMs)} s${limitMs === undefined ? '' : ` / ${limitSeconds(limitMs)} s timeout`}`;
export const runningSideLabel = (limitMs: number): string => `${limitSeconds(limitMs)} s bounded request`;
export const UNAVAILABLE_CHIP = 'Unavailable';
export const UNAVAILABLE_TEXT = 'Filters and saved view preserved; retry does not discard the graph.';
export const UNAVAILABLE_SIDE_LABEL = '0 new data retrieved';
export const unavailableHeadline = (source: string): string => `${source} unavailable. The loaded graph remains available.`;
export const REPEATED_TIMEOUTS_CHIP = 'Repeated timeouts';
export const repeatedTimeoutsHeadline = (source: string): string => `${source} unavailable after repeated timeouts. The loaded graph remains available.`;
