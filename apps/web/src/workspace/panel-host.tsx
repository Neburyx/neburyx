import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { PanelBoundary } from './panel-boundary.js';
import { dockLimits, drawnWidth, floatingLimits, floatingPlacement, PANEL_GAP, PANEL_RAIL_WIDTH, type WidthLimits } from './panel-limits.js';
import { useDragResize, type PanelAnchor } from './panel-resize.js';
import { usePanels, type RegisteredPanel } from './panel-registry.js';
import { useElementSize } from './use-element-size.js';

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
          <PanelBoundary title={panel.title}>
            <Content />
          </PanelBoundary>
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

function FloatingPanel({ panel, side, top, inset, canvas }: { readonly panel: RegisteredPanel; readonly side: PanelAnchor; readonly top: number; readonly inset: number; readonly canvas: { readonly width: number | undefined; readonly height: number | undefined } }) {
  const sizes = useStoreSelector(useClientState().presentation.view, (current) => current.panelSizes);
  const { collapsed, toggle } = useCollapsed(panel);
  const limits = floatingLimits(canvas.width, inset);
  const width = drawnWidth(sizes.get(panel.id), panel.initialWidth, limits);
  const placement = floatingPlacement(top, canvas.height);
  return (
    <aside className="floating-panel" aria-label={panel.title} style={{ top: placement.top, [side]: inset, width, ...(placement.maxHeight === undefined ? {} : { maxHeight: placement.maxHeight }) }}>
      <PanelBox panel={panel} anchor={side} width={width} limits={limits} collapsed={collapsed} form="bar" onToggle={toggle} />
    </aside>
  );
}

/** The layer over the canvas that holds the floating panels, each at its own side and top, the later registered above the earlier. */
export function FloatingPanels() {
  const floating = usePanels().filter((panel) => panel.placement.kind === 'floating');
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  const canvas = useElementSize(layer);
  if (floating.length === 0) return null;
  return (
    <div ref={setLayer} className="panel-layer">
      {floating.map((panel) => (panel.placement.kind === 'floating' ? <FloatingPanel key={panel.registration} panel={panel} side={panel.placement.side} top={panel.placement.top} inset={panel.placement.inset ?? PANEL_GAP} canvas={canvas} /> : null))}
    </div>
  );
}
