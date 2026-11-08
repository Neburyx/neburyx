import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useCanvasCommands, type CanvasCommands } from '../canvas/canvas-commands.js';
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../canvas/zoom.js';
import { useClientState, useVisibleGraph } from '../state/context.js';
import { layoutLabel } from '../state/layout-choice.js';
import { useStoreSelector } from '../state/store.js';
import { LayoutList } from './layout-list.js';
import { placeAbove, type Placement } from './menu-placement.js';

const NEUTRAL_ZOOM = 1;

function LayoutControl({ commands, hasEntities }: { readonly commands: CanvasCommands | undefined; readonly hasEntities: boolean }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | undefined>(undefined);
  const [, remeasure] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const state = useClientState();
  const chosen = layoutLabel(useStoreSelector(state.presentation.view, (current) => current.layout));
  const usable = commands !== undefined && hasEntities;
  const shown = open && usable;

  useEffect(() => {
    if (!usable && open) setOpen(false);
  }, [usable, open]);

  useLayoutEffect(() => {
    const control = button.current;
    const element = holder.current;
    if (!shown || control === null || element === null) return;
    const size = element.getBoundingClientRect();
    const next = placeAbove(control.getBoundingClientRect(), { width: size.width, height: size.height }, { width: window.innerWidth, height: window.innerHeight });
    if (placement === undefined || placement.left !== next.left || placement.top !== next.top) setPlacement(next);
  });

  useEffect(() => {
    if (!shown) {
      setPlacement(undefined);
      return undefined;
    }
    const onResize = (): void => remeasure((count) => count + 1);
    const onPress = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && (holder.current?.contains(target) === true || button.current?.contains(target) === true)) return;
      setOpen(false);
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('pointerdown', onPress, true);
    };
  }, [shown]);

  const placed = placement !== undefined;
  useEffect(() => {
    if (!shown || !placed) return;
    holder.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [shown, placed]);

  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  };
  const onPopupKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      button.current?.focus();
      setOpen(false);
    }
  };

  return (
    <>
      <button
        type="button"
        ref={button}
        className="zoom-button zoom-button-layout"
        aria-label={`Layout: ${chosen}`}
        aria-haspopup="menu"
        aria-expanded={shown}
        disabled={!usable}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span aria-hidden="true">{chosen} ▾</span>
      </button>
      {shown ? (
        <div className="layout-popup" ref={holder} style={placement === undefined ? { left: 0, top: 0, visibility: 'hidden' } : { left: placement.left, top: placement.top }}>
          <div className="menu-panel" onKeyDown={onPopupKeyDown}>
            <LayoutList
              disabled={!usable}
              run={() => commands?.layout()}
              done={() => close(true)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

export function ZoomControls() {
  const state = useClientState();
  const commands = useCanvasCommands();
  const zoom = useStoreSelector(state.presentation.view, (current) => current.viewport?.zoom) ?? NEUTRAL_ZOOM;
  const hasEntities = useVisibleGraph().nodes.length > 0;
  return (
    <div className="zoom-controls" role="group" aria-label="Zoom">
      <button type="button" className="zoom-button" aria-label="Zoom out" disabled={commands === undefined || zoom <= ZOOM_MIN} onClick={() => commands?.zoomBy(1 / ZOOM_STEP)}>
        <span aria-hidden="true">−</span>
      </button>
      <span className="zoom-percentage">{Math.round(zoom * 100)}%</span>
      <button type="button" className="zoom-button" aria-label="Zoom in" disabled={commands === undefined || zoom >= ZOOM_MAX} onClick={() => commands?.zoomBy(ZOOM_STEP)}>
        <span aria-hidden="true">+</span>
      </button>
      <button type="button" className="zoom-button zoom-button-fit" aria-label="Fit to view" disabled={commands === undefined || !hasEntities} onClick={() => commands?.fit()}>
        <span className="icon icon-fit" aria-hidden="true" />
      </button>
      <span className="zoom-divider" aria-hidden="true">
        │
      </span>
      <LayoutControl commands={commands} hasEntities={hasEntities} />
    </div>
  );
}
