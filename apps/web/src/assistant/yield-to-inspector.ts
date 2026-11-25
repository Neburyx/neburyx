import { useEffect, useRef, useState } from 'react';
import { INSPECTOR_PANEL_ID } from '../inspector/inspector-layout.js';
import { useClientState } from '../state/context.js';
import { usePanelRegistered } from '../workspace/panel-registry.js';
import { ASSISTANT_COPY } from './copy.js';
import { ASSISTANT_PANEL_ID, ASSISTANT_PANEL_WIDE_SIZE } from './panel-layout.js';

/** Whether the inspector's panel is open, by whatever opened it (a click on an element, the keyboard, a selection made in the chat window, a deep link). */
export function useInspectorOpen(): boolean {
  return usePanelRegistered(INSPECTOR_PANEL_ID);
}

/** How long the sentence of the narrowing stays in its live region: long enough to be spoken once, never kept until something else is said over it. */
const SAID_FOR_MS = 6000;

/**
 * A Wide Assistant would run over the inspector's place and, beside it, over every panel on the left, so the two are never wide at once. The Assistant returns to its normal width when the inspector opens while it is Wide, and
 * also when the Assistant comes into view (is opened, or returns from the pop-out note) with the inspector open and a Wide width kept; the sentence that says so is given back for a live region of its own and held for a few
 * seconds. Wide is then off while the inspector is open (`WideButton`) and available again when it closes. A panel collapsed because the chat is open in another window (`yielding` false) is left as it is, and a width the person
 * drags to afterwards stands. The thread is not touched: only the panel's width changes.
 */
export function useNarrowWhenInspectorOpens(yielding: boolean): string | undefined {
  const { presentation } = useClientState();
  const open = useInspectorOpen();
  const before = useRef({ open: false, yielding: false });
  const [said, setSaid] = useState(false);
  useEffect(() => {
    const edge = (open && !before.current.open) || (yielding && !before.current.yielding);
    before.current = { open, yielding };
    if (!open) {
      setSaid(false);
      return undefined;
    }
    if (!edge || !yielding) return undefined;
    const stored = presentation.view.getState().panelSizes.get(ASSISTANT_PANEL_ID);
    if (stored === undefined || stored < ASSISTANT_PANEL_WIDE_SIZE) return undefined;
    presentation.clearPanelSize(ASSISTANT_PANEL_ID);
    setSaid(true);
    return undefined;
  }, [open, yielding, presentation]);
  useEffect(() => {
    if (!said) return undefined;
    const timer = window.setTimeout(() => setSaid(false), SAID_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [said]);
  return said ? ASSISTANT_COPY.narrowedForInspector : undefined;
}
