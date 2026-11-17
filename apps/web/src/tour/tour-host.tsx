import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { OPENING_LINK } from '../investigations/messages.js';
import { useApiClient } from '../api/client-context.js';
import { useCanvasCommands } from '../canvas/canvas-commands.js';
import { demoCasesOf } from '../first-run/demo-case.js';
import { linkFor } from '../investigations/deep-link.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { useCurrentSource } from '../shell/use-current-source.js';
import { useClientState } from '../state/context.js';
import { elementKey } from '../state/keys.js';
import { useStoreSelector } from '../state/store.js';
import { entityBox, keepWorkBox, scopeBox, searchBox, type Box } from './anchors.js';
import { TOUR_STEPS } from './tour-copy.js';
import { TourOverlay, TourWaiting } from './tour-overlay.js';
import { endTour, openingDemo, showStep, startTour, tourState, waitForInvestigation } from './tour-store.js';

const HOME = '/';
const INVESTIGATION_PATH = /^\/explore\/[^/]+$/;

/** An address of one investigation; the bare Explore page has no investigation. */
function isInvestigationPath(pathname: string): boolean {
  return pathname.startsWith(EXPLORE_PATH) && INVESTIGATION_PATH.test(pathname);
}

/**
 * The guided tour: the overlay, the walk from Home into the demo case, the stored choice and the automatic start.
 * It reads the page and navigates; it never calls a read of the graph, an expansion or a save of its own.
 */
export function TourHost() {
  const client = useApiClient();
  const shell = useShellData();
  const navigate = useNavigate();
  const { pathname, state: navigationState } = useLocation();
  const clientState = useClientState();
  const canvas = useCanvasCommands();
  const state = useStoreSelector(tourState, (value) => value);
  const current = useCurrentSource().current;
  const sourceId = current?.kind === 'bound' ? current.source.id : current?.kind === 'bound-unknown' ? current.sourceId : undefined;
  const starting = useStoreSelector(clientState.investigation, (investigation) => investigation.record?.startingEntity);
  const expected = useRef<string>(HOME);
  const opened = useRef<string | undefined>(undefined);
  const started = useRef(false);
  const seen = useRef(pathname);
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const stateRef = useRef<unknown>(navigationState);
  stateRef.current = navigationState;
  const [offer, setOffer] = useState(false);
  const returnTo = useRef<Element | null>(null);
  const demo = demoCasesOf(answeredData(shell.sources)?.items ?? [])[0];

  // what had the focus when the tour started, so it goes back there when the tour closes
  useEffect(() => {
    let was = tourState.getState().mode;
    return tourState.subscribe(() => {
      const now = tourState.getState().mode;
      if (was === 'off' && now !== 'off') {
        returnTo.current = document.activeElement;
        expected.current = pathRef.current;
        opened.current = undefined;
      }
      if (was !== 'off' && now === 'off') {
        const target = returnTo.current;
        returnTo.current = null;
        if (target instanceof HTMLElement && target.isConnected && (document.activeElement === document.body || document.activeElement === null || document.activeElement.closest('.tour-layer') !== null)) target.focus();
      }
      was = now;
    });
  }, []);

  // the automatic start: once per page load, only when the preferences were read and hold no tour, and only where Home's search box is
  // (a first-run page has none, so the tour waits for the Home that follows)
  useEffect(() => {
    const controller = new AbortController();
    void client.getPreferences(controller.signal).then((answer) => {
      if (!controller.signal.aborted) setOffer(answer.ok && answer.value.preferences.tour === undefined);
    });
    return () => controller.abort();
  }, [client]);

  useEffect(() => {
    if (!offer || started.current || pathname !== HOME) return undefined;
    const begin = (): boolean => {
      if (started.current || document.querySelector('.home-search') === null) return false;
      started.current = true;
      if (tourState.getState().mode === 'off') {
        expected.current = HOME;
        startTour();
      }
      return true;
    };
    if (begin()) return undefined;
    const observer = new MutationObserver(() => {
      if (begin()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [offer, pathname]);

  // navigating away ends the tour and stores nothing; the wait for an investigation keeps it
  useEffect(() => {
    const mode = tourState.getState().mode;
    const moved = seen.current !== pathname;
    seen.current = pathname;
    // only a change of address is judged; a change of step is the tour's own move
    if (!moved) return;
    if (mode === 'off' || mode === 'waiting') {
      if (mode === 'waiting' && isInvestigationPath(pathname)) {
        expected.current = pathname;
        showStep(1);
      }
      return;
    }
    if (mode === 'opening') {
      // the demo case was shown (the open answers with `resumed`); a held open lands on the investigation already open, which is not the tour's
      const shown = typeof (stateRef.current as { resumed?: unknown } | null | undefined)?.resumed === 'boolean';
      if (isInvestigationPath(pathname) && shown) {
        expected.current = pathname;
        showStep(1);
      } else if (pathname !== opened.current) endTour();
      return;
    }
    if (pathname !== expected.current) endTour();
  }, [pathname]);

  // the open of the demo case failed: the page shows its own failure and the tour ends with nothing stored
  useEffect(() => {
    if (state.mode !== 'opening') return undefined;
    const observer = new MutationObserver(() => {
      // on the link's own page, anything but "Opening…" is an outcome that is not the demo case shown: a failure, not found, an unknown type
      if (pathRef.current === opened.current && !document.body.textContent.includes(OPENING_LINK)) endTour();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [state.mode]);

  const step = state.mode === 'step' ? state.step : -1;
  const startKey = sourceId === undefined || starting === null || starting === undefined ? undefined : elementKey({ sourceId, entityType: starting.entityType, stableId: starting.stableId });

  const measure = useCallback((): Box | undefined => {
    if (step === 0) return searchBox();
    if (step === 1) return scopeBox();
    if (step === 2) {
      if (startKey === undefined || canvas === undefined) return undefined;
      try {
        return entityBox(canvas.anchorOf(startKey));
      } catch {
        return undefined;
      }
    }
    return step === 3 ? keepWorkBox() : undefined;
  }, [step, startKey, canvas]);

  const finish = useCallback(
    (value: 'completed' | 'skipped'): void => {
      endTour();
      // a failed store of a convenience is not worth a message; the tour is offered again at the next visit
      void Promise.resolve(client.putPreferences({ preferences: { tour: value } })).catch(() => undefined);
    },
    [client],
  );
  const skip = useCallback((): void => finish('skipped'), [finish]);

  const next = (): void => {
    if (step === TOUR_STEPS.length - 1) {
      finish('completed');
      return;
    }
    if (step > 0) {
      showStep(step + 1);
      return;
    }
    const path = demo === undefined ? undefined : linkFor({ sourceId: demo.sourceId, entityType: demo.entityType, stableId: demo.stableId, caseRef: demo.caseRef });
    if (demo === undefined || path === undefined) {
      waitForInvestigation();
      return;
    }
    opened.current = path.split('?')[0];
    openingDemo();
    navigate(path);
  };

  const back = (): void => {
    if (step === 1 && pathname !== HOME) {
      expected.current = HOME;
      navigate(HOME);
    }
    showStep(Math.max(0, step - 1));
  };

  if (state.mode === 'waiting') return <TourWaiting onSkip={skip} />;
  if (state.mode !== 'step') return null;
  return <TourOverlay step={state.step} measure={measure} onSkip={skip} onBack={back} onNext={next} />;
}
