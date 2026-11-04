import type { SourceProfile } from '@neburyx/contracts';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ClientState } from '../state/client-state.js';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { writeReadout } from '../dev/canvas-readout.js';
import { StateError } from '../state/errors.js';
import { drawnKeys } from '../state/loaded-graph.js';
import { useStoreSelector } from '../state/store.js';
import { formatNumber, notDrawnLine } from '../workspace/scope-text.js';
import { buildScene } from './build-scene.js';
import { useCanvasCommandsHandle } from './canvas-commands.js';
import { captionFontsReady, loadCaptionFonts } from './fonts.js';
import { useCreateRenderer } from './renderer-context.js';
import { selectionAfterBox, type BoxSelection } from './box-selection.js';
import { selectionAfterClick, type Click } from './selection-gestures.js';
import type { CanvasEvents, CanvasRenderer, RightClick, Scene } from './scene.js';

export const RENDERER_UNAVAILABLE = 'RENDERER_UNAVAILABLE';

const counted = (value: number, one: string, many: string): string => `${formatNumber(value)} ${value === 1 ? one : many}`;

function applyClick(state: ClientState, click: Click): void {
  const { tool, selection } = state.presentation.view.getState();
  replaceSelection(state, selectionAfterClick(tool, selection, click));
}

/** A right-click on an item that is not selected selects it first, on a selected item keeps the selection, on empty canvas leaves it; a click on something that is not drawn opens nothing. */
function openContextMenu(state: ClientState, request: RightClick): void {
  const { target, x, y } = request;
  if (target === undefined) {
    state.presentation.setOpenMenu({ kind: 'canvas', key: undefined, x, y });
    return;
  }
  if (!drawnKeys(state.loadedGraph()).has(target.key)) return;
  if (!state.presentation.view.getState().selection.has(target.key)) state.presentation.select([target.key]);
  state.presentation.setOpenMenu({ kind: target.kind, key: target.key, x, y });
}

function applyBox(state: ClientState, box: BoxSelection): void {
  replaceSelection(state, selectionAfterBox(state.presentation.view.getState().selection, box));
}

function replaceSelection(state: ClientState, next: readonly string[] | undefined): void {
  if (next === undefined) return;
  try {
    state.presentation.select(next);
  } catch (error) {
    // a click can arrive for an item the investigation no longer holds; that is stale and changes nothing
    if (!(error instanceof StateError) || error.code !== 'UNKNOWN_ELEMENT') throw error;
  }
}

export function GraphCanvas({ profile, view = 'fit' }: { readonly profile?: SourceProfile | undefined; readonly view?: Scene['view'] }) {
  const createRenderer = useCreateRenderer();
  const commands = useCanvasCommandsHandle();
  const state = useClientState();
  const graph = useLoadedGraph();
  const positions = useStoreSelector(state.presentation.view, (current) => current.positions);
  const selection = useStoreSelector(state.presentation.view, (current) => current.selection);
  const tool = useStoreSelector(state.presentation.view, (current) => current.tool);
  const source = useStoreSelector(state.investigation, (current) => current.sourceId);
  const scene = useMemo(() => buildScene(graph, positions, profile, selection, tool, source, view), [graph, positions, profile, selection, tool, source, view]);
  const container = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<CanvasRenderer | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const descriptionId = useId();

  useEffect(() => {
    let created: CanvasRenderer | undefined;
    try {
      created = createRenderer();
      const reported = created;
      const events: CanvasEvents = {
        viewport: (viewport) => {
          state.presentation.setViewport(viewport);
          if (__DEV_TOOLS__ && container.current !== null) writeReadout(container.current, { ...reported.describe(), viewport });
        },
        click: (click) => applyClick(state, click),
        box: (box) => applyBox(state, box),
        contextMenu: (request) => openContextMenu(state, request),
      };
      created.mount(container.current ?? undefined, events, state.presentation.view.getState().viewport);
    } catch {
      // the notice names the stable code; the library's own message is not shown
      created?.dispose();
      setFailed(true);
      return undefined;
    }
    const mounted = created;
    setFailed(false);
    setRenderer(mounted);
    return () => {
      mounted.dispose();
      setRenderer(undefined);
    };
  }, [createRenderer]);

  useEffect(() => (renderer === undefined || failed ? undefined : commands.attach(renderer, () => setFailed(true))), [renderer, failed, commands]);

  useEffect(() => {
    if (renderer === undefined) return undefined;
    let current = true;
    const draw = (): void => {
      if (!current) return;
      try {
        for (const [id, position] of renderer.draw(scene)) state.presentation.setPosition(id, position);
        if (__DEV_TOOLS__ && container.current !== null) writeReadout(container.current, { ...renderer.describe(), viewport: renderer.inspect().viewport });
        setFailed(false);
      } catch {
        // the notice names the stable code; the library's own message is not shown
        setFailed(true);
      }
    };
    if (captionFontsReady()) draw();
    else void loadCaptionFonts().then(draw, draw);
    return () => {
      current = false;
    };
  }, [renderer, scene, state]);

  return (
    <>
      <div ref={container} className="graph-canvas" role="img" aria-label="Graph canvas" aria-describedby={descriptionId} />
      <p id={descriptionId} className="visually-hidden">
        {counted(graph.nodes.length, 'entity', 'entities')} and {counted(graph.edges.length, 'relationship', 'relationships')} loaded
        {scene.omitted === 0 ? '' : `; ${notDrawnLine(scene.omitted)}`}
        {scene.selection.size === 0 ? '' : `; ${formatNumber(scene.selection.size)} selected`}
      </p>
      {failed ? (
        <p role="alert" className="canvas-notice">
          {RENDERER_UNAVAILABLE}
        </p>
      ) : null}
    </>
  );
}
