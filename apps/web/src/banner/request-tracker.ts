import type { ElementRef } from '@neburyx/contracts';
import type { BannerController } from './banner-controller.js';
import type { BannerState } from './banner-state.js';
import { cancelledHeadline, CANCELLED_CHIP, CANCELLED_SIDE_LABEL, CANCELLED_TEXT, PREVIEW_CANCELLED_HEADLINE, PREVIEW_CANCELLED_SIDE_LABEL, RUN_AGAIN, RUNNING_CHIP, RUNNING_TEXT, runningHeadline, runningSideLabel, type RequestKind } from './copy.js';

export const RUNNING_BANNER_ID = 'running';
export const CANCELLED_BANNER_ID = 'cancelled';

/** How long a request runs before its Running state is shown, so that a read that answers at once never flashes a banner. */
export const RUNNING_DELAY_MS = 1000;
/** How often the elapsed time of the Running state is redrawn. */
const TICK_MS = 200;

export interface TrackedCall {
  readonly kind: RequestKind;
  readonly ref: ElementRef;
  /** Stops the request: aborts its fetch. */
  readonly cancel: () => void;
  /** Sends the same request again. */
  readonly again: () => void;
}

export interface TrackedHandle {
  /** True once the person cancelled it; the request's caller then drops any answer and leaves what it had. */
  readonly cancelled: boolean;
  /** The request ended (answered, failed, or was superseded): its Running state goes, without a Cancelled state. */
  finish(): void;
}

export interface RequestTracker {
  begin(call: TrackedCall): TrackedHandle;
}

export interface RequestTrackerDeps {
  /** The title a loaded node is shown by, under the masking in force; undefined when it is not loaded (nothing is guessed from the reference). */
  readonly titleOf: (ref: ElementRef) => string | undefined;
  /** The source's server-side timeout in milliseconds; undefined when it is not known. */
  readonly timeoutOf: (sourceId: string) => number | undefined;
  readonly now?: () => number;
  /** Overrides `RUNNING_DELAY_MS`; for tests only. */
  readonly delayMs?: number;
}

interface Entry {
  readonly call: TrackedCall;
  readonly startedAt: number;
  readonly seq: number;
  due: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  cancelled: boolean;
  open: boolean;
}

/**
 * The requests the canvas has in flight, shown on the banner: the newest one past `RUNNING_DELAY_MS` as Running, with its elapsed time against the source's timeout and a Cancel; a request
 * the person cancels as Cancelled, with Run again. A failure banner of another request is never replaced by Running, and a request that ends takes only its own state away.
 */
export function createRequestTracker(banner: BannerController, deps: RequestTrackerDeps): RequestTracker {
  const now = deps.now ?? Date.now;
  const entries: Entry[] = [];
  let begun = 0;
  /** The requests begun up to the person's last cancel; only a request begun after it may take the place of the Cancelled state. */
  let cancelledAfter = -1;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const showing = (): BannerState | undefined => banner.view.getState().banner;
  const replaceable = (newest: Entry): boolean => {
    const current = showing();
    if (current === undefined || current.id === RUNNING_BANNER_ID) return true;
    return current.id === CANCELLED_BANNER_ID && newest.seq > cancelledAfter;
  };

  const runningState = (entry: Entry): BannerState => {
    const elapsedMs = now() - entry.startedAt;
    const limitMs = deps.timeoutOf(entry.call.ref.sourceId);
    const title = deps.titleOf(entry.call.ref);
    return {
      id: RUNNING_BANNER_ID,
      tone: 'neutral',
      chip: RUNNING_CHIP,
      headline: runningHeadline(entry.call.kind, title, elapsedMs, limitMs),
      text: RUNNING_TEXT,
      ...(limitMs === undefined ? {} : { sideLabel: runningSideLabel(limitMs) }),
      actions: [{ id: 'cancel', label: 'Cancel', run: () => cancelByPerson(entry) }],
      dismissible: false,
    };
  };

  function stopTicker(): void {
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
  }

  function render(): void {
    const newest = [...entries].reverse().find((entry) => entry.due);
    if (newest === undefined) {
      stopTicker();
      if (showing()?.id === RUNNING_BANNER_ID) banner.dismiss(RUNNING_BANNER_ID);
      return;
    }
    if (!replaceable(newest)) return;
    banner.show(runningState(newest));
    ticker ??= setInterval(render, TICK_MS);
  }

  function leave(entry: Entry): void {
    if (!entry.open) return;
    entry.open = false;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entries.splice(entries.indexOf(entry), 1);
  }

  function cancelByPerson(entry: Entry): void {
    if (!entry.open) return;
    entry.cancelled = true;
    cancelledAfter = begun;
    leave(entry);
    entry.call.cancel();
    const preview = entry.call.kind === 'preview';
    banner.show({
      id: CANCELLED_BANNER_ID,
      tone: 'neutral',
      chip: CANCELLED_CHIP,
      headline: preview ? PREVIEW_CANCELLED_HEADLINE : cancelledHeadline(),
      text: CANCELLED_TEXT,
      sideLabel: preview ? PREVIEW_CANCELLED_SIDE_LABEL : CANCELLED_SIDE_LABEL,
      actions: [
        {
          id: 'run-again',
          label: RUN_AGAIN,
          run: () => {
            banner.dismiss(CANCELLED_BANNER_ID);
            entry.call.again();
          },
        },
      ],
    });
    if (!entries.some((each) => each.due)) stopTicker();
  }

  return {
    begin(call) {
      const entry: Entry = { call, startedAt: now(), seq: ++begun, due: false, timer: undefined, cancelled: false, open: true };
      entries.push(entry);
      entry.timer = setTimeout(() => {
        if (!entry.open) return;
        entry.due = true;
        render();
      }, deps.delayMs ?? RUNNING_DELAY_MS);
      return {
        get cancelled() {
          return entry.cancelled;
        },
        finish() {
          if (!entry.open) return;
          leave(entry);
          render();
        },
      };
    },
  };
}
