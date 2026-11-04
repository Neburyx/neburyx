import { useCallback, useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { isPanelSize, PANEL_KEY_STEP, PANEL_KEY_STEP_SHIFT, type WidthLimits } from './panel-limits.js';

export type PanelAnchor = 'left' | 'right';

export interface ResizeInput {
  readonly id: string;
  /** The side of the screen the panel is anchored to: dragging away from it grows the panel. */
  readonly anchor: PanelAnchor;
  /** The width drawn now, held to the limits. */
  readonly width: number;
  readonly limits: WidthLimits;
}

export interface HandleProps {
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  readonly onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
  readonly onClick: (event: MouseEvent<HTMLElement>) => void;
}

interface Session {
  /** The handle that started the drag; the others ignore its pointer. */
  readonly owner: object;
  readonly pointerId: number;
  readonly id: string;
  readonly anchor: PanelAnchor;
  readonly startX: number;
  readonly startWidth: number;
  /** The width stored before the drag, put back when the drag is cancelled; undefined when none was stored. */
  readonly previous: number | undefined;
  moved: boolean;
  /** The pointer was released: the last position is still written, by the frame that is waiting, and the drag ends with it. */
  released: boolean;
  pending: number | undefined;
  /** The width last written to the store by this drag, so a release does not write the same width again. */
  committed: number | undefined;
  frame: number | undefined;
}

const RESIZING_CLASS = 'panel-resizing';

/** The one drag there is on the page, from the press until its last write: a second press on any handle, and the resize keys, wait for it. It outlives the handle that started it, which is how a last write that is waiting for its frame stays covered after the handle is gone. */
let active: Session | undefined;

/** Dragging a panel's inner edge: live, at most one store update per frame, the width held to the limits, the pointer captured, and the whole drag cancelled, with the width put back, when it is interrupted before the pointer is released. */
export function useDragResize(input: ResizeInput): HandleProps {
  const state = useClientState();
  const sourceId = useStoreSelector(state.investigation, (investigation) => investigation.sourceId);
  const latest = useRef(input);
  latest.current = input;
  const owner = useRef({}).current;
  const stopBlur = useRef<(() => void) | undefined>(undefined);

  /** Lets go of the page guard and the blur listener; a frame that is still queued is left to run. */
  const lift = useCallback((): void => {
    stopBlur.current?.();
    stopBlur.current = undefined;
    document.body.classList.remove(RESIZING_CLASS);
  }, []);

  const finish = useCallback(
    (held: Session): void => {
      if (active === held) active = undefined;
      lift();
      if (held.frame !== undefined) cancelAnimationFrame(held.frame);
      held.frame = undefined;
    },
    [lift],
  );

  const write = useCallback(
    (held: Session): void => {
      if (held.pending === undefined || held.pending === held.committed || !isPanelSize(held.pending)) return;
      state.presentation.setPanelSize(held.id, held.pending);
      held.committed = held.pending;
    },
    [state],
  );

  /** An interruption of this handle's drag puts the width back, unless the pointer was already released: that drag was over, so nothing is rolled back and the frame that is waiting still writes its last position, once. */
  const cancel = useCallback((): void => {
    const held = active;
    if (held === undefined || held.owner !== owner) return;
    if (held.released) {
      lift();
      return;
    }
    finish(held);
    if (held.committed === undefined) return;
    if (held.previous === undefined) state.presentation.clearPanelSize(held.id);
    else state.presentation.setPanelSize(held.id, held.previous);
  }, [finish, lift, owner, state]);

  /** The last write of a released drag ends it even when the store throws, so the page is never left waiting for a drag that cannot end; the error is not caught. */
  const flush = (held: Session): void => {
    held.frame = undefined;
    if (active !== held) return;
    try {
      write(held);
    } finally {
      if (held.released) finish(held);
    }
  };

  /** The drag this handle is running, if the event comes from the pointer that started it. */
  const dragOf = (event: PointerEvent<HTMLElement>): Session | undefined => (active?.owner === owner && active.pointerId === event.pointerId ? active : undefined);

  useEffect(() => cancel, [cancel, sourceId]);

  return {
    onKeyDown(event) {
      const { id, anchor, width, limits } = latest.current;
      const grows = anchor === 'right' ? 'ArrowLeft' : 'ArrowRight';
      const shrinks = anchor === 'right' ? 'ArrowRight' : 'ArrowLeft';
      if (active !== undefined || (event.key !== grows && event.key !== shrinks && event.key !== 'Home' && event.key !== 'End')) return;
      event.preventDefault();
      const step = event.shiftKey ? PANEL_KEY_STEP_SHIFT : PANEL_KEY_STEP;
      const wanted = event.key === grows ? width + step : event.key === shrinks ? width - step : event.key === 'Home' ? limits.min : limits.max;
      const next = Math.min(limits.max, Math.max(limits.min, wanted));
      if (next !== width && isPanelSize(next)) state.presentation.setPanelSize(id, next);
    },
    onPointerDown(event) {
      if (event.button !== 0 || active !== undefined) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const { id, anchor, width } = latest.current;
      active = { owner, pointerId: event.pointerId, id, anchor, startX: event.clientX, startWidth: width, previous: state.presentation.view.getState().panelSizes.get(id), moved: false, released: false, pending: undefined, committed: undefined, frame: undefined };
      document.body.classList.add(RESIZING_CLASS);
      window.addEventListener('blur', cancel);
      stopBlur.current = () => window.removeEventListener('blur', cancel);
    },
    onPointerMove(event) {
      const held = dragOf(event);
      if (held === undefined || held.released || (!held.moved && event.clientX === held.startX)) return;
      held.moved = true;
      const delta = held.anchor === 'right' ? held.startX - event.clientX : event.clientX - held.startX;
      const { limits } = latest.current;
      held.pending = Math.min(limits.max, Math.max(limits.min, held.startWidth + delta));
      if (held.frame !== undefined) return;
      held.frame = requestAnimationFrame(() => flush(held));
    },
    onPointerUp(event) {
      const held = dragOf(event);
      if (held === undefined || held.released) return;
      held.released = true;
      if (held.pending === undefined || held.pending === held.committed) {
        finish(held);
        return;
      }
      held.frame ??= requestAnimationFrame(() => flush(held));
    },
    onPointerCancel(event) {
      if (dragOf(event) !== undefined) cancel();
    },
    onLostPointerCapture(event) {
      if (dragOf(event) !== undefined) cancel();
    },
    onClick: (event) => event.stopPropagation(),
  };
}
