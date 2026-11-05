import type { SourceProfile } from '@neburyx/contracts';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ClientState } from '../state/client-state.js';
import type { Position } from '../state/presentation-state.js';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { INSPECT_DRAWING, writeReadout } from '../dev/canvas-readout.js';
import { StateError } from '../state/errors.js';
import { drawnKeys, partitionEdges } from '../state/loaded-graph.js';
import { elementKey } from '../state/keys.js';
import { useStoreSelector } from '../state/store.js';
import { KEY_SCOPE_ATTRIBUTE } from '../workspace/key-binding-handler.js';
import { formatNumber, notDrawnLine } from '../workspace/scope-text.js';
import { buildScene } from './build-scene.js';
import { layoutEntities, placeNewEntities } from './incremental-layout.js';
import { describeWalked } from './walk.js';
import { useCanvasCommandsHandle } from './canvas-commands.js';
import { captionFontsReady, loadCaptionFonts } from './fonts.js';
import { useCreateRenderer } from './renderer-context.js';
import { selectionAfterBox, type BoxSelection } from './box-selection.js';
import { applyClick, openContextMenu, replaceSelection } from './apply-click.js';
import type { CanvasEvents, CanvasRenderer, EntityMove, RightClick, Scene } from './scene.js';

export const RENDERER_UNAVAILABLE = 'RENDERER_UNAVAILABLE';
export const WALK_SENTENCE = 'Press Enter or Space to walk the entities and relationships, Escape to leave the walk.';

const counted = (value: number, one: string, many: string): string => `${formatNumber(value)} ${value === 1 ? one : many}`;

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

export function GraphCanvas({ profile, view = 'fit' }: { readonly profile?: SourceProfile | undefined; readonly view?: Scene['view'] }) {
  const createRenderer = useCreateRenderer();
  const commands = useCanvasCommandsHandle();
  const state = useClientState();
  const graph = useLoadedGraph();
  const positions = useStoreSelector(state.presentation.view, (current) => current.positions);
  const selection = useStoreSelector(state.presentation.view, (current) => current.selection);
  const pins = useStoreSelector(state.presentation.view, (current) => current.pins);
  const tool = useStoreSelector(state.presentation.view, (current) => current.tool);
  const walking = useStoreSelector(state.presentation.view, (current) => current.walking);
  const focused = useStoreSelector(state.presentation.view, (current) => current.focused);
  const moveNote = useStoreSelector(state.presentation.view, (current) => current.moveNote);
  const menuOpen = useStoreSelector(state.presentation.view, (current) => current.openMenu !== undefined);
  const source = useStoreSelector(state.investigation, (current) => current.sourceId);
  const placed = useMemo(
    () => placeNewEntities({ ids: graph.nodes.map((node) => elementKey(node.ref)), links: graph.edges.map((edge) => [elementKey(edge.from), elementKey(edge.to)] as const), positions }),
    [graph, positions],
  );
  const scene = useMemo(() => buildScene(graph, placed.size === 0 ? positions : new Map([...positions, ...placed]), profile, selection, tool, source, view, pins, walking ? focused : undefined), [graph, positions, placed, profile, selection, tool, source, view, pins, walking, focused]);
  const announcement = walking && scene.focused !== undefined ? describeWalked(graph, profile, pins, scene.focused) : undefined;

  useEffect(() => {
    if (focused !== undefined && !drawnKeys(graph).has(focused)) state.presentation.forgetFocused();
  }, [graph, focused, state]);

  // A menu opened from the walk holds the focus for a while and gives it back; if it closes with the focus elsewhere the walk is over.
  useEffect(() => {
    if (walking && !menuOpen && document.activeElement !== container.current) state.presentation.endWalk();
  }, [walking, menuOpen, state]);
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
      if (__DEV_TOOLS__ && container.current !== null) Reflect.set(container.current, INSPECT_DRAWING, () => reported.inspect());
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
        if (__DEV_TOOLS__ && container.current !== null) writeReadout(container.current, { ...renderer.describe(), viewport: renderer.viewport(), drawn: { positions: renderer.positions(), pinned: state.presentation.view.getState().pins, focused: scene.focused } });
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
      <div
        ref={container}
        className="graph-canvas"
        role="application"
        tabIndex={0}
        aria-label="Graph canvas"
        aria-describedby={descriptionId}
        {...{ [KEY_SCOPE_ATTRIBUTE]: 'canvas' }}
        onBlur={() => {
          state.presentation.announceMove(undefined);
          if (state.presentation.view.getState().openMenu === undefined) state.presentation.endWalk();
        }}
        // the renderer blurs the focused element on a mouse press, and a script focus would draw the keyboard ring unless it says it should not
        onMouseUp={(event) => event.currentTarget.focus({ preventScroll: true, focusVisible: false })}
      />
      <p id={descriptionId} className="visually-hidden">
        {counted(graph.nodes.length, 'entity', 'entities')} and {counted(graph.edges.length, 'relationship', 'relationships')} loaded
        {scene.omitted === 0 ? '' : `; ${notDrawnLine(scene.omitted)}`}
        {scene.selection.size === 0 ? '' : `; ${formatNumber(scene.selection.size)} selected`}
        {scene.pinned.size === 0 ? '' : `; ${formatNumber(scene.pinned.size)} pinned`}
        . {WALK_SENTENCE}
      </p>
      <p role="status" aria-live="polite" className="visually-hidden">
        {moveNote === undefined ? announcement : <span key={moveNote.serial}>{moveNote.text}</span>}
      </p>
      {failed ? (
        <p role="alert" className="canvas-notice">
          {RENDERER_UNAVAILABLE}
        </p>
      ) : null}
    </>
  );
}
