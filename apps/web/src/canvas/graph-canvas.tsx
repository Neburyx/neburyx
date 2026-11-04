import type { SourceProfile } from '@neburyx/contracts';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ClientState } from '../state/client-state.js';
import type { Position } from '../state/presentation-state.js';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { writeReadout } from '../dev/canvas-readout.js';
import { StateError } from '../state/errors.js';
import { drawnKeys, partitionEdges } from '../state/loaded-graph.js';
import { elementKey } from '../state/keys.js';
import { useStoreSelector } from '../state/store.js';
import { formatNumber, notDrawnLine } from '../workspace/scope-text.js';
import { buildScene } from './build-scene.js';
import { layoutEntities, placeNewEntities } from './incremental-layout.js';
import { useCanvasCommandsHandle } from './canvas-commands.js';
import { captionFontsReady, loadCaptionFonts } from './fonts.js';
import { useCreateRenderer } from './renderer-context.js';
import { selectionAfterBox, type BoxSelection } from './box-selection.js';
import { selectionAfterClick, type Click } from './selection-gestures.js';
import type { CanvasEvents, CanvasRenderer, EntityMove, RightClick, Scene } from './scene.js';

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

/** A drag of an entity that is no longer held, or that was pinned meanwhile, is stale and changes nothing. */
function applyMove(state: ClientState, move: EntityMove): void {
  if (state.presentation.view.getState().pins.has(move.id)) return;
  try {
    state.presentation.setPosition(move.id, move.position);
  } catch (error) {
    if (!(error instanceof StateError) || error.code !== 'UNKNOWN_ELEMENT') throw error;
  }
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
  const pins = useStoreSelector(state.presentation.view, (current) => current.pins);
  const tool = useStoreSelector(state.presentation.view, (current) => current.tool);
  const source = useStoreSelector(state.investigation, (current) => current.sourceId);
  const placed = useMemo(
    () => placeNewEntities({ ids: graph.nodes.map((node) => elementKey(node.ref)), links: graph.edges.map((edge) => [elementKey(edge.from), elementKey(edge.to)] as const), positions }),
    [graph, positions],
  );
  const scene = useMemo(() => buildScene(graph, placed.size === 0 ? positions : new Map([...positions, ...placed]), profile, selection, tool, source, view, pins), [graph, positions, placed, profile, selection, tool, source, view, pins]);
  const container = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<CanvasRenderer | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const descriptionId = useId();

  useEffect(() => {
    let created: CanvasRenderer | undefined;
    let current = true;
    const whileMounted =
      <Arguments extends unknown[]>(act: (...given: Arguments) => void) =>
      (...given: Arguments): void => {
        if (current) act(...given);
      };
    try {
      created = createRenderer();
      const reported = created;
      const events: CanvasEvents = {
        viewport: whileMounted((viewport) => {
          state.presentation.setViewport(viewport);
          if (__DEV_TOOLS__ && container.current !== null) writeReadout(container.current, { ...reported.describe(), viewport });
        }),
        click: whileMounted((click) => applyClick(state, click)),
        box: whileMounted((box) => applyBox(state, box)),
        contextMenu: whileMounted((request) => openContextMenu(state, request)),
        move: whileMounted((move) => applyMove(state, move)),
        failed: whileMounted(() => setFailed(true)),
      };
      created.mount(container.current ?? undefined, events, state.presentation.view.getState().viewport);
    } catch {
      // the notice names the stable code; the library's own message is not shown
      current = false;
      created?.dispose();
      setFailed(true);
      return undefined;
    }
    const mounted = created;
    setFailed(false);
    setRenderer(mounted);
    return () => {
      mounted.dispose();
      current = false;
      setRenderer(undefined);
    };
  }, [createRenderer]);

  // The positions the entities had before the last layout run, until the drawing of its result has succeeded: a drawing that fails puts them back.
  const beforeLayout = useRef<ReadonlyMap<string, Position> | undefined>(undefined);
  // After a layout whose drawing failed has been rolled back, the drawing of the restored positions must not clear the notice.
  const keepNotice = useRef(false);
  const layoutNow = useCallback((): void => {
    const loaded = state.loadedGraph();
    const { positions: stored, pins: held } = state.presentation.view.getState();
    const next = layoutEntities({
      ids: loaded.nodes.map((node) => elementKey(node.ref)),
      links: partitionEdges(loaded).drawable.map((edge) => [elementKey(edge.from), elementKey(edge.to)] as const),
      positions: stored,
      pinned: held,
    });
    if (next.size === 0) return;
    beforeLayout.current = new Map([...next.keys()].flatMap((id) => {
      const position = stored.get(id);
      return position === undefined ? [] : [[id, position] as const];
    }));
    state.presentation.setPositions(next);
  }, [state]);

  useEffect(() => (renderer === undefined || failed ? undefined : commands.attach(renderer, () => setFailed(true), layoutNow)), [renderer, failed, commands, layoutNow]);

  useEffect(() => {
    if (renderer === undefined) return undefined;
    let current = true;
    const draw = (): void => {
      if (!current) return;
      try {
        renderer.draw(scene);
        beforeLayout.current = undefined;
        if (placed.size > 0) state.presentation.setPositions(placed);
        if (__DEV_TOOLS__ && container.current !== null) writeReadout(container.current, { ...renderer.describe(), viewport: renderer.viewport(), drawn: { positions: renderer.positions(), pinned: state.presentation.view.getState().pins } });
        if (keepNotice.current) keepNotice.current = false;
        else setFailed(false);
      } catch {
        // the notice names the stable code; the library's own message is not shown
        const previous = beforeLayout.current;
        beforeLayout.current = undefined;
        if (previous !== undefined) {
          keepNotice.current = true;
          state.presentation.setPositions(previous);
        }
        setFailed(true);
      }
    };
    if (captionFontsReady()) draw();
    else void loadCaptionFonts().then(draw, draw);
    return () => {
      current = false;
    };
  }, [renderer, scene, placed, state]);

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
