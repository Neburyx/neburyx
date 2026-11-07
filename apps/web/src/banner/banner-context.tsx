import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useStoreSelector } from '../state/store.js';
import type { BannerController, BannerView } from './banner-controller.js';

const BannerContext = createContext<BannerController | undefined>(undefined);

export function BannerProvider({ controller, children }: { readonly controller: BannerController; readonly children: ReactNode }) {
  return (
    <BannerContext.Provider value={controller}>
      {children}
    </BannerContext.Provider>
  );
}

export function useBanner(): BannerController {
  const controller = useContext(BannerContext);
  if (controller === undefined) throw new Error('the banner is not provided');
  return controller;
}

const NOTHING: BannerView = { banner: undefined, announcement: undefined };
const NOTHING_STORE = { getState: () => NOTHING, subscribe: () => () => undefined };

export function useBannerView(): BannerView {
  const controller = useContext(BannerContext);
  return useStoreSelector(controller === undefined ? NOTHING_STORE : controller.view, (view) => view);
}

/** Empties the banner when the workspace goes; the change of investigation is handled by `bindBannerToInvestigation`. */
export function useClearBannerOnLeave(): void {
  const controller = useContext(BannerContext);
  useEffect(
    () => () => {
      controller?.clear();
    },
    [controller],
  );
}
