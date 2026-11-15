import type { PathsHeavy, PathsOk, PathsRequest } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { UNEXPECTED } from '../api/use-request.js';
import type { FailureReporter } from '../api/failure-reporter.js';
import type { BannerController } from '../banner/banner-controller.js';
import { pathsRunningText } from '../banner/copy.js';
import { heavyBannerState, HEAVY_BANNER_ID } from '../banner/heavy-banner.js';
import type { RequestTracker } from '../banner/request-tracker.js';
import { partialBannerState, PARTIAL_BANNER_ID } from './paths-banners.js';
import { partialReason } from './copy.js';
import { createStore, type ReadableStore } from '../state/store.js';

export interface PathsRunView {
  readonly running: boolean;
  /** The last answer that carried paths; it stays while a newer search is on its way, after a failure and after a cancel. */
  readonly result: PathsOk | undefined;
  /** The stop of a heavy search, until the person refines, continues or changes the form. */
  readonly heavy: PathsHeavy | undefined;
  /** A failure the app's banner did not show. */
  readonly failure: ApiFailure | undefined;
  readonly cancelled: boolean;
  /** The request the heavy stop, the failure and the cancelled line belong to, for Continue and Run again. */
  readonly ask: PathsRequest | undefined;
}

export interface PathsRunOptions {
  readonly report?: FailureReporter;
  /** Shows a search that runs long as the Running state of the banner and a cancelled one as the Cancelled state. */
  readonly tracker?: RequestTracker;
  /** Shows the Heavy operation and Partial states; they last as long as the answer they belong to. */
  readonly banner?: BannerController;
  /** The source's timeout in milliseconds, for the reason the Partial state gives. */
  readonly timeoutMs?: () => number | undefined;
  /** Puts the focus in the panel, opening it: asked by an action of a banner. */
  readonly focus?: (target: 'from' | 'list') => void;
}

export interface PathsRunStore extends ReadableStore<PathsRunView> {
  readonly run: (ask: PathsRequest) => void;
  readonly cancel: () => void;
  /** Takes down the heavy stop, the failure and the cancelled line (the form changed). */
  readonly clear: () => void;
  /** Aborts a search on its way, as leaving the panel does. */
  readonly dispose: () => void;
}

const IDLE: PathsRunView = { running: false, result: undefined, heavy: undefined, failure: undefined, cancelled: false, ask: undefined };

/**
 * One search at a time: a newer search, a cancel and leaving abort the older one, and an answer to an aborted search is never shown. It lives outside React. Nothing here touches the graph: a search is a list
 * beside it, and a path is added only when the person chooses it.
 */
export function createPathsRunStore(client: ApiClient, sourceId: string, options: PathsRunOptions = {}): PathsRunStore {
  const { report, tracker, banner } = options;
  const store = createStore<PathsRunView>(IDLE);
  let newest: AbortController | undefined;
  let tracked: ReturnType<RequestTracker['begin']> | undefined;
  const patch = (change: Partial<PathsRunView>): void => store.setState({ ...store.getState(), ...change });
  const takeBannersDown = (): void => {
    banner?.dismiss(HEAVY_BANNER_ID);
    banner?.dismiss(PARTIAL_BANNER_ID);
  };

  const run = (ask: PathsRequest): void => {
    newest?.abort();
    tracked?.finish();
    takeBannersDown();
    const controller = new AbortController();
    newest = controller;
    const handle = tracker?.begin({
      kind: 'paths',
      ref: { sourceId, entityType: ask.from.entityType, stableId: ask.from.stableId },
      runningText: pathsRunningText(ask.maxHops),
      cancel: () => {
        if (newest !== controller) return;
        newest = undefined;
        controller.abort();
        patch({ running: false, cancelled: true });
      },
      again: () => run(ask),
    });
    tracked = handle;
    patch({ running: true, heavy: undefined, failure: undefined, cancelled: false, ask });
    const send = async (): Promise<void> => {
      let result: Awaited<ReturnType<ApiClient['findPaths']>>;
      try {
        result = await client.findPaths(ask, controller.signal);
      } catch {
        result = UNEXPECTED;
      }
      if (newest !== controller) return;
      newest = undefined;
      handle?.finish();
      if (!result.ok) {
        if (result.failure.code === 'ABORTED') patch({ running: false });
        else patch({ running: false, failure: report?.(result.failure, sourceId, () => run(ask)) === true ? undefined : result.failure });
        return;
      }
      const answer = result.value;
      if (answer.status === 'heavy') {
        patch({ running: false, heavy: answer });
        banner?.show(
          heavyBannerState({
            estimate: { value: answer.threshold, quality: 'lowerBound' },
            threshold: answer.threshold,
            limit: answer.continueLimit,
            waiting: 1,
            perType: false,
            refine: () => {
              takeBannersDown();
              store.setState({ ...store.getState(), heavy: undefined });
              options.focus?.('from');
            },
            proceed: () => {
              takeBannersDown();
              run({ ...ask, continue: true });
            },
          }),
        );
        return;
      }
      patch({ running: false, result: answer });
      if (answer.partial && answer.retained !== undefined && answer.requested !== undefined) {
        banner?.show(partialBannerState({ reason: partialReason(options.timeoutMs?.()), retained: answer.retained, requested: answer.requested, review: () => options.focus?.('list') }));
      }
    };
    void send();
  };

  return {
    ...store,
    run,
    cancel: () => {
      if (newest === undefined) return;
      if (tracked !== undefined) {
        tracked.cancel();
        return;
      }
      newest.abort();
      newest = undefined;
      patch({ running: false, cancelled: true });
    },
    clear: () => {
      const { heavy, failure, cancelled } = store.getState();
      takeBannersDown();
      if (heavy !== undefined || failure !== undefined || cancelled) patch({ heavy: undefined, failure: undefined, cancelled: false });
    },
    dispose: () => {
      newest?.abort();
      newest = undefined;
      tracked?.finish();
      takeBannersDown();
    },
  };
}
