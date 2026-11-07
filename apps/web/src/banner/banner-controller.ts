import type { ErrorCode, ErrorResponse } from '@neburyx/contracts';
import { createStore, readable, type ReadableStore } from '../state/store.js';
import type { BannerAction, BannerState, BannerTone } from './banner-state.js';

export type ServerFailure = ErrorResponse['error'];

export class BannerCauseError extends Error {
  readonly code = 'BANNER_CAUSE_TAKEN';

  constructor(readonly errorCode: ErrorCode) {
    super(`BANNER_CAUSE_TAKEN: ${errorCode}`);
    this.name = 'BannerCauseError';
  }
}

export interface PartialWording {
  readonly itemNoun: string;
  readonly reason?: string;
  readonly review?: { readonly label: string; readonly run: () => void };
}

export interface FailureOptions {
  readonly partial?: PartialWording;
  /** Sends the request that failed again, the same one; without it the banner has no Retry. */
  readonly resend?: () => void;
}

export interface BannerCauseContext {
  readonly partial?: PartialWording;
  /** The Retry action of the banner with this ID, or undefined when the caller gave nothing to send again. It dismisses the banner first, then sends once. */
  retry(bannerId: string, label: string): BannerAction | undefined;
}

export type BannerDescriber = (failure: ServerFailure, context: BannerCauseContext) => BannerState | undefined;

export interface Announcement {
  readonly tone: BannerTone;
  readonly text: string;
}

export interface BannerView {
  readonly banner: BannerState | undefined;
  readonly announcement: Announcement | undefined;
}

export interface BannerController {
  readonly view: ReadableStore<BannerView>;
  show(state: BannerState): void;
  /** Clears the banner only when it is the one with this ID, so a request that ends cannot clear a later request's banner. */
  dismiss(id: string): void;
  clear(): void;
  /** Makes a feature's banner state known for an error code; a code that already has one is refused. Returns the function that takes it out again. */
  registerCause(code: ErrorCode, describe: BannerDescriber): () => void;
  /** Shows the state its describer builds for the failure. False when the code has no describer or the describer builds nothing; the caller then keeps its own presentation. */
  showFailure(failure: ServerFailure, options?: FailureOptions): boolean;
}

const EMPTY: BannerView = { banner: undefined, announcement: undefined };

const announcementOf = (state: BannerState): Announcement => ({ tone: state.tone, text: `${state.chip}. ${state.headline}. ${state.text}` });

export function createBannerController(): BannerController {
  const store = createStore<BannerView>(EMPTY);
  const describers = new Map<ErrorCode, BannerDescriber>();
  const controller: BannerController = {
    view: readable(store),
    show(state) {
      const current = store.getState();
      const sameBanner = current.banner?.id === state.id;
      const announcement = !sameBanner || state.announce === true || current.announcement === undefined ? announcementOf(state) : current.announcement;
      store.setState({ banner: state, announcement });
    },
    dismiss(id) {
      if (store.getState().banner?.id !== id) return;
      store.setState(EMPTY);
    },
    clear() {
      store.setState(EMPTY);
    },
    registerCause(code, describe) {
      if (describers.has(code)) throw new BannerCauseError(code);
      describers.set(code, describe);
      return () => {
        if (describers.get(code) === describe) describers.delete(code);
      };
    },
    showFailure(failure, options = {}) {
      const describe = describers.get(failure.code);
      if (describe === undefined) return false;
      const state = describe(failure, {
        ...(options.partial === undefined ? {} : { partial: options.partial }),
        retry(bannerId, label) {
          const { resend } = options;
          if (resend === undefined) return undefined;
          let used = false;
          return {
            id: 'retry',
            label,
            run() {
              if (used) return;
              used = true;
              controller.dismiss(bannerId);
              resend();
            },
          };
        },
      });
      if (state === undefined) return false;
      controller.show(state);
      return true;
    },
  };
  return controller;
}
