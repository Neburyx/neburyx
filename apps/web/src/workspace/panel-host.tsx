import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { PanelBoundary } from './panel-boundary.js';
import { dockLimits, drawnWidth, floatingLimits, floatingPlacement, PANEL_GAP, PANEL_MIN_WIDTH, PANEL_RAIL_WIDTH, topBelowObstacles, windowShareWidth, type CanvasBox, type WidthLimits } from './panel-limits.js';
import { useDragResize, type PanelAnchor } from './panel-resize.js';
import { usePanels, type RegisteredPanel } from './panel-registry.js';
import { useElementSize } from './use-element-size.js';
import { useWindowWidth } from './use-window-width.js';

export interface PanelSize {
  readonly width: number;
  readonly limits: WidthLimits;
}

export const PanelSizeContext = createContext<PanelSize | undefined>(undefined);

export function usePanelSize(): PanelSize | undefined {
  return useContext(PanelSizeContext);
}

function PanelToggle({ panel, collapsed, onToggle }: { readonly panel: RegisteredPanel; readonly collapsed: boolean; readonly onToggle: (focusMoves: boolean) => void }) {
  const label = `${collapsed ? 'Expand' : 'Collapse'} ${panel.title}`;
  return (
    <button type="button" className="panel-toggle" aria-label={label} aria-expanded={!collapsed} onClick={(event: MouseEvent<HTMLButtonElement>) => onToggle(document.activeElement === event.currentTarget)}>
      <span className={`icon ${collapsed ? 'icon-panel-expand' : 'icon-panel-collapse'}`} aria-hidden="true" />
    </button>
  );
}

function PanelHandle({ panel, panelDomId, anchor, width, limits }: { readonly panel: RegisteredPanel; readonly panelDomId: string; readonly anchor: PanelAnchor; readonly width: number; readonly limits: WidthLimits }) {
  const handle = useDragResize({ id: panel.id, anchor, width, limits });
  return <div className="panel-handle" role="separator" aria-orientation="vertical" aria-label={`Resize ${panel.title}`} aria-controls={panelDomId} aria-valuenow={width} aria-valuemin={limits.min} aria-valuemax={limits.max} tabIndex={0} {...handle} />;
}

/** A panel is collapsed under the registration it was collapsed with, so one registered again opens expanded. */
function useCollapsed(panel: RegisteredPanel): { readonly collapsed: boolean; readonly toggle: () => void } {
  const state = useClientState();
  const collapsed = useStoreSelector(state.presentation.view, (current) => current.collapsedPanels.get(panel.id) === panel.registration);
  return { collapsed, toggle: () => state.presentation.setPanelCollapsed(panel.id, panel.registration, !collapsed) };
}

interface PanelBoxProps {
  readonly panel: RegisteredPanel;
  /** The side the panel is anchored to; its handle and collapse button are on the other edge. */
  readonly anchor: PanelAnchor;
  readonly width: number;
  readonly limits: WidthLimits;
  readonly collapsed: boolean;
  /** Collapsed, a dock panel is a rail with the title written vertically and a floating one a bar. */
  readonly form: 'rail' | 'bar';
  readonly onToggle: () => void;
}

function PanelBox({ panel, anchor, width, limits, collapsed, form, onToggle }: PanelBoxProps) {
  const panelDomId = useId();
  const frame = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    frame.current?.querySelector<HTMLElement>('.panel-toggle')?.focus();
  }, [collapsed]);
  const toggle = (focusMoves: boolean): void => {
    moveFocus.current = focusMoves;
    onToggle();
  };
  const Content = panel.content;
  const classes = ['panel-frame', ...(anchor === 'left' ? ['panel-frame-left'] : []), ...(collapsed ? ['panel-frame-collapsed', ...(form === 'bar' ? ['panel-frame-bar'] : [])] : [])];
  return (
    <div ref={frame} className={classes.join(' ')} style={collapsed && form === 'bar' ? { height: PANEL_RAIL_WIDTH } : undefined}>
      <div id={panelDomId} className="panel" data-panel={panel.id}>
        {collapsed ? (
          <div className={`panel-${form}`}>
            <PanelToggle panel={panel} collapsed onToggle={toggle} />
            <span className={`panel-${form}-title`}>{panel.title}</span>
          </div>
        ) : null}
        <div className="panel-content" hidden={collapsed}>
          <PanelSizeContext.Provider value={{ width, limits }}>
            <PanelBoundary title={panel.title}>
              <Content />
            </PanelBoundary>
          </PanelSizeContext.Provider>
        </div>
      </div>
      {collapsed ? null : <PanelHandle panel={panel} panelDomId={panelDomId} anchor={anchor} width={width} limits={limits} />}
      {collapsed ? null : <PanelToggle panel={panel} collapsed={false} onToggle={toggle} />}
    </div>
  );
}

function DockPanel({ panel }: { readonly panel: RegisteredPanel }) {
  const sizes = useStoreSelector(useClientState().presentation.view, (current) => current.panelSizes);
  const { collapsed, toggle } = useCollapsed(panel);
  const [column, setColumn] = useState<HTMLElement | null>(null);
  const { width: workspaceWidth } = useElementSize(column?.parentElement ?? null);
  const limits = dockLimits(workspaceWidth, panel.maxWidth);
  const width = collapsed ? PANEL_RAIL_WIDTH : drawnWidth(sizes.get(panel.id), panel.initialWidth, limits);
  return (
    <aside ref={setColumn} className="panel-dock" aria-label={panel.title} style={{ width: width + 2 * PANEL_GAP }}>
      <PanelBox panel={panel} anchor="right" width={width} limits={limits} collapsed={collapsed} form="rail" onToggle={toggle} />
    </aside>
  );
}

/** The column beside the canvas: it takes space, so the canvas region is narrower by the panel and the gaps either side of it. */
export function DockColumn() {
  const dock = usePanels().find(({ placement }) => placement.kind === 'dock');
  return dock === undefined ? null : <DockPanel key={dock.registration} panel={dock} />;
}

interface FloatingProps {
  readonly panel: RegisteredPanel;
  readonly side: PanelAnchor;
  readonly top: number;
  readonly inset: number;
  readonly canvas: { readonly width: number | undefined; readonly height: number | undefined };
  readonly windowWidth: number | undefined;
  readonly obstacles: readonly CanvasBox[];
  /** The room that other panels need beside this one: how wide it may be made is limited by it. */
  readonly reserve: number;
}

function limitsOfFloating(panel: RegisteredPanel, inset: number, canvasWidth: number | undefined, windowWidth: number | undefined, reserve = 0): WidthLimits {
  return floatingLimits(canvasWidth, inset, windowShareWidth(panel.widestShareOfWindow, windowWidth), { reserve, floor: panel.placement.kind === 'floating' && panel.placement.beside !== undefined ? PANEL_MIN_WIDTH : panel.initialWidth });
}

function FloatingPanel({ panel, side, top, inset, canvas, windowWidth, obstacles, reserve }: FloatingProps) {
  const sizes = useStoreSelector(useClientState().presentation.view, (current) => current.panelSizes);
  const { collapsed, toggle } = useCollapsed(panel);
  const limits = limitsOfFloating(panel, inset, canvas.width, windowWidth, reserve);
  const width = drawnWidth(sizes.get(panel.id), panel.initialWidth, limits);
  const span = canvas.width === undefined ? undefined : side === 'right' ? { left: canvas.width - inset - width, right: canvas.width - inset } : { left: inset, right: inset + width };
  const placement = floatingPlacement(span === undefined ? top : topBelowObstacles(top, span, obstacles), canvas.height);
  return (
    <aside className="floating-panel" aria-label={panel.title} style={{ top: placement.top, [side]: inset, width, ...(placement.maxHeight === undefined ? {} : { maxHeight: placement.maxHeight }) }}>
      <PanelBox panel={panel} anchor={side} width={width} limits={limits} collapsed={collapsed} form="bar" onToggle={toggle} />
    </aside>
  );
}

const CANVAS_OBSTACLES = '.graph-scope, .region-tool-strip';

interface CanvasLayout {
  readonly canvas: { readonly width: number | undefined; readonly height: number | undefined };
  readonly obstacles: readonly CanvasBox[];
}

const UNMEASURED_LAYOUT: CanvasLayout = { canvas: { width: undefined, height: undefined }, obstacles: [] };
const knownSize = (value: number): number | undefined => (value > 0 ? value : undefined);

function sameLayout(held: CanvasLayout, next: CanvasLayout): boolean {
  return held.canvas.width === next.canvas.width && held.canvas.height === next.canvas.height && held.obstacles.length === next.obstacles.length && held.obstacles.every((box, index) => box.left === next.obstacles[index]?.left && box.top === next.obstacles[index]?.top && box.right === next.obstacles[index]?.right && box.bottom === next.obstacles[index]?.bottom);
}

/** The size of the panel layer and the boxes in the canvas region that a panel must not cover, measured before the first paint and again, still before the next paint, whenever the layer or one of them changes size, the region gains or loses a child, or a style is written on the region; the region is the layer's parent. */
function useCanvasLayout(layer: HTMLElement | null): CanvasLayout {
  const [layout, setLayout] = useState<CanvasLayout>(UNMEASURED_LAYOUT);
  useLayoutEffect(() => {
    const region = layer?.parentElement;
    if (layer === null || region === null || region === undefined) return undefined;
    const measure = (): CanvasLayout => {
      const origin = region.getBoundingClientRect();
      const size = layer.getBoundingClientRect();
      const obstacles = [...region.querySelectorAll(CANVAS_OBSTACLES)]
        .map((element) => element.getBoundingClientRect())
        .map((box) => ({ left: box.left - origin.left, top: box.top - origin.top, right: box.left - origin.left + box.width, bottom: box.top - origin.top + box.height }))
        .filter((box) => box.right > box.left && box.bottom > box.top);
      return { canvas: { width: knownSize(size.width), height: knownSize(size.height) }, obstacles };
    };
    // flushed so that the panels are placed again before the frame that follows the change is painted
    const update = (): void => {
      const next = measure();
      flushSync(() => setLayout((held) => (sameLayout(held, next) ? held : next)));
    };
    const sizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    const watch = (): void => {
      sizes?.disconnect();
      sizes?.observe(region);
      sizes?.observe(layer);
      for (const element of region.querySelectorAll(CANVAS_OBSTACLES)) sizes?.observe(element);
    };
    const changes = new MutationObserver((records) => {
      if (records.some((record) => record.type === 'childList')) watch();
      update();
    });
    changes.observe(region, { childList: true, attributes: true, attributeFilter: ['style'] });
    watch();
    const initial = measure();
    setLayout((held) => (sameLayout(held, initial) ? held : initial));
    return () => {
      changes.disconnect();
      sizes?.disconnect();
    };
  }, [layer]);
  return layout;
}

const RESERVED = { right: { variable: '--panel-reserved-right', attribute: 'data-panels-right' }, left: { variable: '--panel-reserved-left', attribute: 'data-panels-left' } } as const;
const NO_ROOM_HINT = 'data-no-room-hint';
const NO_ROOM_NOTICE = 'data-no-room-notice';
/** The free width below which a hint or a notice is not drawn: it would be a column of a few letters. */
const NOTICE_MIN_FREE_WIDTH = 160;
/** Where the starting hint begins at the least: clear of the tool strip, as `--tool-strip-clear` says. */
const TOOL_STRIP_CLEAR = 72;

interface Reach {
  readonly right: number;
  readonly left: number;
  readonly canvasWidth: number | undefined;
}

/** Tells the canvas region how far its floating panels reach in from each side, so a hint or a notice can keep to the free area between them, and when that area is too narrow to draw one; the region is the layer's parent. */
function useReservedReach(layer: HTMLElement | null, { right, left, canvasWidth }: Reach): void {
  useEffect(() => {
    const region = layer?.parentElement;
    if (region === null || region === undefined) return undefined;
    const clear = (): void => {
      for (const { variable, attribute } of Object.values(RESERVED)) {
        region.style.removeProperty(variable);
        region.removeAttribute(attribute);
      }
      region.removeAttribute(NO_ROOM_HINT);
      region.removeAttribute(NO_ROOM_NOTICE);
    };
    clear();
    const reach = { right, left };
    for (const side of ['right', 'left'] as const) {
      if (reach[side] <= 0) continue;
      region.style.setProperty(RESERVED[side].variable, `${reach[side]}px`);
      region.setAttribute(RESERVED[side].attribute, '');
    }
    if (canvasWidth !== undefined) {
      const noticeFree = canvasWidth - (left + PANEL_GAP) - (right + PANEL_GAP);
      if (noticeFree < NOTICE_MIN_FREE_WIDTH) region.setAttribute(NO_ROOM_NOTICE, '');
      if (right > 0 && noticeFree - Math.max(0, TOOL_STRIP_CLEAR - (left + PANEL_GAP)) < NOTICE_MIN_FREE_WIDTH) region.setAttribute(NO_ROOM_HINT, '');
    }
    return clear;
  }, [layer, right, left, canvasWidth]);
}

/** The layer over the canvas that holds the floating panels, each at its own side and top, the later registered above the earlier. */
export function FloatingPanels() {
  const sizes = useStoreSelector(useClientState().presentation.view, (current) => current.panelSizes);
  const floating = usePanels().filter((panel) => panel.placement.kind === 'floating');
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  const { canvas, obstacles } = useCanvasLayout(layer);
  const windowWidth = useWindowWidth();
  // how far the left panels reach, and for a right-hand panel the room the left panels and a panel hanging beside it need: a panel is never made wider over them (it opens at its own width wherever there is no room)
  const leftReach = floating.reduce((reach, panel) => {
    if (panel.placement.kind !== 'floating' || panel.placement.side !== 'left') return reach;
    const own = panel.placement.inset ?? PANEL_GAP;
    return Math.max(reach, own + drawnWidth(sizes.get(panel.id), panel.initialWidth, limitsOfFloating(panel, own, canvas.width, windowWidth)));
  }, 0);
  const reserveOf = (panel: RegisteredPanel): number => {
    if (panel.placement.kind !== 'floating' || panel.placement.side !== 'right') return 0;
    if (leftReach <= 0) return 0;
    // a panel hanging beside this one keeps its least width
    const hanging = floating.some((other) => other.placement.kind === 'floating' && other.placement.beside === panel.id);
    return leftReach + PANEL_GAP + (hanging ? PANEL_GAP + PANEL_MIN_WIDTH : 0);
  };
  const insetOf = (placement: { readonly inset?: number; readonly beside?: string }): number => {
    const next = placement.beside === undefined ? undefined : floating.find(({ id }) => id === placement.beside);
    if (next === undefined) return placement.inset ?? PANEL_GAP;
    const own = next.placement.kind === 'floating' ? (next.placement.inset ?? PANEL_GAP) : PANEL_GAP;
    return PANEL_GAP + drawnWidth(sizes.get(next.id), next.initialWidth, limitsOfFloating(next, own, canvas.width, windowWidth, reserveOf(next))) + PANEL_GAP;
  };
  const reachOf = (side: PanelAnchor): number =>
    floating.reduce((reach, panel) => {
      if (panel.placement.kind !== 'floating' || panel.placement.side !== side) return reach;
      const inset = insetOf(panel.placement);
      return Math.max(reach, inset + drawnWidth(sizes.get(panel.id), panel.initialWidth, limitsOfFloating(panel, inset, canvas.width, windowWidth, reserveOf(panel))));
    }, 0);
  useReservedReach(layer, { right: reachOf('right'), left: reachOf('left'), canvasWidth: canvas.width });
  if (floating.length === 0) return null;
  return (
    <div ref={setLayer} className="panel-layer">
      {floating.map((panel) => (panel.placement.kind === 'floating' ? <FloatingPanel key={panel.registration} panel={panel} side={panel.placement.side} top={panel.placement.top} inset={insetOf(panel.placement)} canvas={canvas} windowWidth={windowWidth} obstacles={obstacles} reserve={reserveOf(panel)} /> : null))}
    </div>
  );
}
