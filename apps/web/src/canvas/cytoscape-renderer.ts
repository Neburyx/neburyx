import type { IconKey } from '@neburyx/contracts';
import cytoscape, { type Core, type EdgeSingular, type NodeSingular, type StylesheetJson } from 'cytoscape';
import type { PointerTool, Position, Viewport } from '../state/presentation-state.js';
import { CAPTION_HEIGHT, CAPTION_TOP, CAPTION_WIDTH } from './caption-layout.js';
import { paintCaption, type CaptionPainter } from './caption-painter.js';
import { glyphUri } from './glyphs.js';
import { pinBadgeUri } from './pin-badge.js';
import { createHoverTip, type HoverTip } from './hover-tip.js';
import { AGGREGATE_WIDTH, CAPTION_KNOCKOUT, ARROW_GAP, CAPTION_MIN_ZOOM, ARROW_SHAPE, DASH_PATTERN, DERIVED_COLOR, DOT_PATTERN, EDGE_COLOR, EDGE_WIDTH, FIT_PADDING, FOCUS_COLOR, FOCUS_RING_GAP, FOCUS_RING_WIDTH, GLYPH_COLOR, GLYPH_SIZE, LABEL_FILL, LABEL_FONT_SIZE, NODE_DIAMETER, NODE_FILL, NODE_OUTER_DIAMETER, NODE_OUTLINE, NODE_OUTLINE_WIDTH, PIN_BADGE_SIZE, PILL_FILL, PILL_OUTLINE_WIDTH, SELECTED_COLOR, SELECTED_HALO_COLOR, SELECTED_HALO_OPACITY, SELECTED_HALO_PADDING, SELECTED_LINE_EXTRA, SELECTED_OUTLINE_WIDTH, TIP_GAP } from './look.js';
import type { RelationshipLook } from './relationship-look.js';
import { createBoxGesture, type BoxOverlay } from './box-gesture.js';
import { createBoxOverlay } from './box-overlay.js';
import { fitViewport, type Size } from './fit.js';
import { followSize } from './follow-size.js';
import { suppressNativeMenu } from './native-menu.js';
import { ZOOM_MAX, ZOOM_MIN } from './zoom.js';
import type { CanvasRenderer, DrawnCounts, Inspection, Scene } from './scene.js';

// Entities are not selected by the library: clicks and boxes are reported and decided by the caller. An entity is grabbed only while the scene says it may be dragged.
const POINTER = { userPanningEnabled: true, userZoomingEnabled: true, boxSelectionEnabled: false, autoungrabify: false, autounselectify: true };

const CAPTION_BUDGET_MS = 4;
/** Setting the class is cheap, but drawing an entity again after its style changed costs about half a millisecond, so hiding the captions of a few hundred entities in one frame would be a long frame (233 ms at 4x for 120 entities); it is done this many entities at a time over the next frames. */
const FAR_ENTITIES_PER_FRAME = 10;

const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((key) => b.has(key));

interface CaptionJob {
  readonly id: string;
  readonly key: string;
  readonly iconKey: IconKey;
  readonly line1: string;
  readonly line2: string;
  readonly pinned: boolean;
}

const edgeData = (look: RelationshipLook) => ({ aggregate: look.aggregate, origin: look.origin, label: look.label ?? '', tip: look.tip ?? '' });


// Cytoscape keeps the object it is given as the node's position and writes to it, so every position is copied in.
/** A clear image that holds the caption's place in the list until the caption is painted, so the pin badge keeps its own place and size. */
const NO_CAPTION = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// The pin badge sits on the disc's edge, at 45 degrees to the upper right of the centre.
const PIN_BADGE_X = NODE_DIAMETER / 2 + (Math.SQRT1_2 * NODE_OUTER_DIAMETER) / 2 - PIN_BADGE_SIZE / 2;
const PIN_BADGE_Y = NODE_DIAMETER / 2 - (Math.SQRT1_2 * NODE_OUTER_DIAMETER) / 2 - PIN_BADGE_SIZE / 2;

export const STYLE: StylesheetJson = [
  {
    selector: 'node',
    style: {
      width: NODE_DIAMETER,
      height: NODE_DIAMETER,
      'background-color': NODE_FILL,
      'border-width': NODE_OUTLINE_WIDTH,
      'border-color': NODE_OUTLINE,
      // the glyph sits inside the disc and the caption hangs below it, so the second image is drawn over the node, not clipped to it
      'background-width': [`${GLYPH_SIZE}px`, `${CAPTION_WIDTH}px`, `${PIN_BADGE_SIZE}px`],
      'background-height': [`${GLYPH_SIZE}px`, `${CAPTION_HEIGHT}px`, `${PIN_BADGE_SIZE}px`],
      'background-position-x': ['50%', '50%', `${PIN_BADGE_X}px`],
      'background-position-y': ['50%', `${CAPTION_TOP}px`, `${PIN_BADGE_Y}px`],
      'background-fit': ['none', 'none', 'none'],
      'background-repeat': ['no-repeat', 'no-repeat', 'no-repeat'],
      'background-image-containment': ['inside', 'over', 'over'],
      'background-clip': ['node', 'none', 'none'],
      'bounds-expansion': CAPTION_WIDTH / 2,
      'overlay-opacity': 0,
    },
  },
  {
    selector: 'edge',
    style: {
      width: EDGE_WIDTH,
      'line-color': EDGE_COLOR,
      'line-style': 'solid',
      'curve-style': 'bezier',
      'target-arrow-shape': ARROW_SHAPE,
      'target-distance-from-node': ARROW_GAP,
      'target-arrow-color': EDGE_COLOR,
      label: 'data(label)',
      color: DERIVED_COLOR,
      'font-family': 'Inter, system-ui, sans-serif',
      'font-weight': 500,
      'font-size': LABEL_FONT_SIZE,
      'text-rotation': 'none',
      'text-background-color': LABEL_FILL,
      'text-background-opacity': 1,
      'text-background-padding': '3px',
      'overlay-opacity': 0,
    },
  },
  {
    selector: 'edge[origin = "derived"]',
    style: { 'line-color': DERIVED_COLOR, 'line-style': 'dashed', 'line-dash-pattern': DASH_PATTERN, 'target-arrow-shape': 'none' },
  },
  // An aggregate node stands for neighbors that are not loaded: a dashed outline, joined by a thin dashed line without an arrow.
  { selector: 'node[?remainder]', style: { 'border-style': 'dashed' } },
  { selector: 'edge[?remainder]', style: { width: 1, 'line-style': 'dashed', 'line-dash-pattern': DASH_PATTERN, 'target-arrow-shape': 'none' } },
  { selector: 'edge[origin = "unknown"]', style: { 'line-style': 'dotted', 'line-dash-pattern': DOT_PATTERN } },
  {
    selector: 'node[?selected]',
    style: {
      'border-color': SELECTED_COLOR,
      'border-width': SELECTED_OUTLINE_WIDTH,
      width: NODE_OUTER_DIAMETER - SELECTED_OUTLINE_WIDTH,
      height: NODE_OUTER_DIAMETER - SELECTED_OUTLINE_WIDTH,
      'underlay-color': SELECTED_HALO_COLOR,
      'underlay-opacity': SELECTED_HALO_OPACITY,
      'underlay-padding': SELECTED_HALO_PADDING,
      'underlay-shape': 'ellipse',
    },
  },
  {
    selector: 'edge[?aggregate]',
    style: {
      width: AGGREGATE_WIDTH,
      'text-background-color': PILL_FILL,
      'text-background-shape': 'roundrectangle',
      'text-background-padding': '4px',
      'text-border-width': PILL_OUTLINE_WIDTH,
      'text-border-style': 'solid',
      'text-border-color': DERIVED_COLOR,
      'text-border-opacity': 1,
    },
  },
  // Below the zoom where captions are read an entity is drawn with its glyph and badge only, and a relationship without its label, except a selected one; the one under the pointer is told in the page's own text (the hover tip).
  { selector: 'node.far', style: { 'background-image-opacity': [1, 0, 1] } },
  { selector: 'node.far[?selected], node.far[?focused]', style: { 'background-image-opacity': [1, 1, 1] } },
  { selector: 'edge.far', style: { label: '' } },
  { selector: 'edge.far[?selected], edge.far[?focused]', style: { label: 'data(label)' } },
  { selector: 'edge[?selected]', style: { 'line-color': SELECTED_COLOR, 'target-arrow-color': SELECTED_COLOR, width: EDGE_WIDTH + SELECTED_LINE_EXTRA } },
  { selector: 'edge[?selected][?aggregate]', style: { width: AGGREGATE_WIDTH + SELECTED_LINE_EXTRA } },
  // The ring of the keyboard walk: an outline around an entity and an underlay behind a relationship.
  { selector: 'node[?ringed]', style: { 'outline-width': FOCUS_RING_WIDTH, 'outline-color': FOCUS_COLOR, 'outline-style': 'solid', 'outline-offset': FOCUS_RING_GAP, 'outline-opacity': 1 } },
  // the band has a gap of the canvas colour between it and the line, so a derived or selected relationship keeps its own look inside the ring
  { selector: 'edge[?ringed]', style: { 'underlay-color': FOCUS_COLOR, 'underlay-opacity': 1, 'underlay-padding': FOCUS_RING_WIDTH + FOCUS_RING_GAP, 'line-outline-width': FOCUS_RING_GAP, 'line-outline-color': CAPTION_KNOCKOUT } },
];

/** The library's own handle, named here so that a test need not import the library. */
export type RendererCore = Core;

export interface CytoscapeRendererOptions {
  readonly paintCaption?: CaptionPainter;
  /** Runs a callback on the next animation frame; tests pass their own. */
  readonly nextFrame?: (callback: () => void) => void;
  /** Gives the library's own handle to a caller as soon as it is made, so a test can send it pointer events a headless drawing has no pointer for. */
  readonly onCore?: (core: RendererCore) => void;
  /** The area the drawing is fitted into; by default the canvas element's, which a headless drawing has none of. */
  readonly canvasSize?: () => Size;
}

const browserFrame = (callback: () => void): void => {
  requestAnimationFrame(callback);
};

export function createCytoscapeRenderer(options: CytoscapeRendererOptions = {}): CanvasRenderer {
  let core: Core | undefined;
  let fitted = false;
  let fits = 0;
  let paints = false;
  const painter = options.paintCaption ?? paintCaption;
  const nextFrame = options.nextFrame ?? browserFrame;
  let tool: PointerTool = 'select';
  let teardown: (() => void) | undefined;
  let surfaced = false;
  let flushViewport: (() => void) | undefined;
  let lastSource: string | null | undefined;
  // The entity being dragged, where it was at the grab, and whether the drag was interrupted: a cancelled drag keeps putting the entity back until the library sees the release.
  let dragging: { readonly id: string; readonly start: Position; readonly tool: PointerTool; readonly pinned: ReadonlySet<string>; cancelled: boolean } | undefined;
  let drawnPinned: ReadonlySet<string> = new Set();
  // The element the pointer is over and the element the canvas draws in, so the cursor follows a change of tool or pin under a pointer that does not move.
  let surface: HTMLElement | undefined;
  let hovered: string | undefined;
  let remembered: string | undefined;
  let far = false;
  let tip: HoverTip | undefined;
  let tipHidden = false;
  let syncTipNow: (() => void) | undefined;
  let tipFocus: string | undefined;
  let farQueue: string[] = [];
  let farScheduled = false;
  const classifyFar = (cy: Core, count: number): void => {
    cy.batch(() => {
      for (let done = 0; farQueue.length > 0 && done < count; done += 1) {
        const id = farQueue.shift();
        const element = id === undefined ? undefined : cy.getElementById(id);
        if (element === undefined || element.empty()) continue;
        if (far) element.addClass('far');
        else element.removeClass('far');
      }
    });
  };
  const runFarQueue = (): void => {
    farScheduled = false;
    if (core === undefined) {
      farQueue = [];
      return;
    }
    classifyFar(core, FAR_ENTITIES_PER_FRAME);
    if (farQueue.length > 0) scheduleFar();
  };
  const scheduleFar = (): void => {
    if (farScheduled) return;
    farScheduled = true;
    nextFrame(runFarQueue);
  };
  const syncFar = (cy: Core, immediate = false): void => {
    const now = cy.zoom() < CAPTION_MIN_ZOOM;
    if (now !== far) {
      far = now;
      farQueue = far ? [...cy.nodes().map((node) => node.id()), ...cy.edges().filter((edge) => edge.data('label') !== '').map((edge) => edge.id())] : cy.elements('.far').map((element) => element.id());
    }
    if (farQueue.length === 0) return;
    if (immediate) classifyFar(cy, farQueue.length);
    else scheduleFar();
  };
  const showCursor = (): void => {
    if (surface !== undefined) surface.style.cursor = hovered !== undefined && tool !== 'pan' && drawnPinned.has(hovered) ? 'not-allowed' : '';
  };
  let reportFailure: () => void = () => undefined;
  // The ticket of the one viewport report that waits for its frame; a source change drops it, and only the frame that holds the current ticket reports.
  let pendingReport: number | undefined;
  let tickets = 0;
  const captions = new Map<string, string>();
  const captionKey = (line1: string, line2: string): string => `${line1}\u0000${line2}`;
  const captionFor = (line1: string, line2: string): string => {
    const key = captionKey(line1, line2);
    const known = captions.get(key);
    if (known !== undefined) return known;
    const painted = painter(line1, line2);
    captions.set(key, painted);
    return painted;
  };

  const glyphs = new Map<string, string>();
  const glyphFor = (key: IconKey): string => {
    const known = glyphs.get(key);
    if (known !== undefined) return known;
    const made = glyphUri(key, GLYPH_COLOR);
    glyphs.set(key, made);
    return made;
  };
  const badge = pinBadgeUri();
  const imagesFor = (iconKey: IconKey, pinned: boolean, caption?: string): string[] => [glyphFor(iconKey), ...(caption === undefined ? (pinned ? [NO_CAPTION] : []) : [caption]), ...(pinned ? [badge] : [])];
  // A caption is painted and encoded on a canvas of its own, which costs a millisecond or more, so an entity is drawn at once with its glyph and the captions follow in the next frames, a few at a time; the frame that adds many entities then stays short.
  let captionQueue: CaptionJob[] = [];
  let captionsScheduled = false;
  const paintQueuedCaptions = (): void => {
    captionsScheduled = false;
    const cy = core;
    if (cy === undefined) {
      captionQueue = [];
      return;
    }
    const started = performance.now();
    try {
      while (captionQueue.length > 0 && performance.now() - started < CAPTION_BUDGET_MS) {
        const job = captionQueue.shift();
        const node = job === undefined ? undefined : cy.getElementById(job.id);
        if (job === undefined || node === undefined || node.empty() || node.data('lookKey') !== job.key) continue;
        node.style('background-image', imagesFor(job.iconKey, job.pinned, captionFor(job.line1, job.line2)));
      }
    } catch {
      captionQueue = [];
      reportFailure();
      return;
    }
    if (captionQueue.length > 0) scheduleCaptions();
  };
  const scheduleCaptions = (): void => {
    if (captionsScheduled) return;
    captionsScheduled = true;
    nextFrame(paintQueuedCaptions);
  };

  const cancelDrag = (): void => {
    if (core === undefined || dragging === undefined || dragging.cancelled) return;
    dragging.cancelled = true;
    core.getElementById(dragging.id).position({ ...dragging.start });
  };

  const requireCore = (): Core => {
    if (core === undefined) throw new Error('the renderer is not mounted');
    return core;
  };

  // A fit shows every entity even when that needs a zoom below the minimum; the minimum then follows the fit, so the wheel cannot zoom out further and zooming in moves toward the range.
  // A drawing with no canvas element has no size of its own (the library reports 1 x 1), so it has none unless a caller says one.
  // The walk moves the view to an element it reaches that is outside the canvas, so its ring and its tip can be seen.
  const revealFocused = (cy: Core, id: string): void => {
    const size = sizeOf(cy);
    if (size.width === 0 || size.height === 0) return;
    const entity = cy.nodes().toArray().find((node) => node.id() === id);
    const relationship = cy.edges().toArray().find((edge) => edge.id() === id);
    const at = entity !== undefined ? entity.renderedPosition() : relationship?.renderedMidpoint();
    if (at === undefined) return;
    const inside = (value: number, extent: number): number => Math.min(Math.max(value, FIT_PADDING), extent - FIT_PADDING) - value;
    const dx = inside(at.x, size.width);
    const dy = inside(at.y, size.height);
    if (dx !== 0 || dy !== 0) cy.panBy({ x: dx, y: dy });
  };
  const sizeOf = (cy: Core): Size => options.canvasSize?.() ?? (surfaced ? { width: cy.width(), height: cy.height() } : { width: 0, height: 0 });

  const showViewport = (cy: Core, viewport: Viewport): void => {
    cy.minZoom(Math.min(ZOOM_MIN, viewport.zoom));
    cy.viewport({ zoom: viewport.zoom, pan: { x: viewport.x, y: viewport.y } });
  };

  const fitEntities = (cy: Core, entitiesOnly = false): void => {
    const entities = cy.nodes('[!remainder]');
    const counted = entitiesOnly && !entities.empty() ? entities : cy.nodes();
    const viewport = fitViewport(counted.boundingBox({}), sizeOf(cy), FIT_PADDING);
    if (viewport !== undefined) showViewport(cy, viewport);
  };

  return {
    mount(container, events, viewport) {
      if (core !== undefined) throw new Error('the renderer is already mounted');
      const created = cytoscape({ container, headless: container === undefined, styleEnabled: true, style: STYLE, layout: { name: 'preset' }, minZoom: ZOOM_MIN, maxZoom: ZOOM_MAX, ...POINTER });
      const report = (): void => {
        if (core === created) events.viewport({ zoom: created.zoom(), x: created.pan().x, y: created.pan().y });
      };
      created.on('viewport', () => {
        created.minZoom(Math.min(ZOOM_MIN, created.zoom()));
        if (pendingReport !== undefined) return;
        tickets += 1;
        const ticket = tickets;
        pendingReport = ticket;
        nextFrame(() => {
          if (pendingReport !== ticket) return;
          pendingReport = undefined;
          report();
        });
      });
      flushViewport = () => {
        if (pendingReport === undefined) return;
        pendingReport = undefined;
        report();
      };
      surface = container;
      tip = container === undefined ? undefined : createHoverTip(container);
      // Where the readable caption of the element under the pointer hangs, shown only below the zoom where the drawn captions are left out; it goes with a pan, a zoom or a grab, and comes back with the next element the pointer enters.
      const syncTip = (): void => {
        const hover = created.elements('.hovered').first();
        const element = hover.nonempty() ? hover : created.elements('[?focused]').first();
        if (tip === undefined || tipHidden || !far || element.empty()) {
          tip?.hide();
          return;
        }
        if (element.isNode()) {
          const title = String(element.data('title') ?? '');
          const at = element.renderedPosition();
          if (title === '') tip.hide();
          else tip.show({ title, detail: String(element.data('detail') ?? '') }, { x: at.x, y: at.y + element.renderedHeight() / 2 + TIP_GAP });
          return;
        }
        const label = String(element.data('tip') || element.data('label') || '');
        const at = element.renderedMidpoint();
        if (label === '') tip.hide();
        else tip.show({ title: label, detail: undefined }, { x: at.x, y: at.y + TIP_GAP });
      };
      const enter = (element: EdgeSingular | NodeSingular): void => {
        remembered = element.id();
        element.addClass('hovered');
        hovered = element.isNode() ? element.id() : undefined;
        tipHidden = false;
        syncTip();
        showCursor();
      };
      const dropTip = (): void => {
        tipHidden = true;
        tip?.hide();
      };
      created.on('pan zoom grab', dropTip);
      created.on('mouseover', 'node, edge', (event) => enter(event.target));
      created.on('mouseout', 'node, edge', (event) => {
        event.target.removeClass('hovered');
        remembered = undefined;
        hovered = undefined;
        syncTip();
        showCursor();
      });
      // The library tells an element it was left only when another one is entered, so the pointer leaving the canvas clears what shows, and the pointer coming back takes it up again.
      created.on('mouseout', (event) => {
        if (event.target !== created) return;
        created.elements('.hovered').removeClass('hovered');
        hovered = undefined;
        syncTip();
        showCursor();
      });
      created.on('mouseover', (event) => {
        if (event.target !== created || remembered === undefined) return;
        const element = created.getElementById(remembered);
        if (element.nonempty()) enter(element);
        else remembered = undefined;
      });
      created.on('zoom', () => syncFar(created));
      syncTipNow = syncTip;
      let ignoreTap = false;
      created.on('tap', (event) => {
        if (ignoreTap) {
          ignoreTap = false;
          return;
        }
        const { target } = event;
        const shift = event.originalEvent instanceof MouseEvent && event.originalEvent.shiftKey;
        if (target === created) events.click({ target: undefined, shift });
        else if ('isNode' in target) events.click({ target: target.id(), shift });
      });
      const overlay = container === undefined ? undefined : createBoxOverlay(container);
      const noOverlay: BoxOverlay = { show: () => undefined, hide: () => undefined };
      const gesture = createBoxGesture({
        overlay: overlay ?? noOverlay,
        centres: () => new Map(created.nodes().map((node) => [node.id(), node.renderedPosition()])),
        select: events.box,
      });
      const insideCanvas = (at: Position): boolean => {
        const size = sizeOf(created);
        return !(size.width > 0 && size.height > 0) || (at.x >= 0 && at.y >= 0 && at.x <= size.width && at.y <= size.height);
      };
      // The library turns a Shift-drag into its own box selection, which is off here, so in the mode pan a Shift-drag moves the view by hand.
      let shiftPan: { readonly origin: Position; readonly pan: Position } | undefined;
      // The event's own position is worked out from the view, which this pan moves, so the pointer's position is read from the browser event.
      const pointer = (event: { readonly originalEvent: unknown; readonly renderedPosition: Position }): Position => {
        if (container === undefined || !(event.originalEvent instanceof MouseEvent)) return event.renderedPosition;
        const rect = container.getBoundingClientRect();
        return { x: event.originalEvent.clientX - rect.left, y: event.originalEvent.clientY - rect.top };
      };
      created.on('tapstart', (event) => {
        ignoreTap = false;
        if (event.target !== created) return;
        const shift = event.originalEvent instanceof MouseEvent && event.originalEvent.shiftKey;
        if (tool === 'pan' && shift) {
          shiftPan = { origin: pointer(event), pan: { ...created.pan() } };
          created.userPanningEnabled(false);
          return;
        }
        if (tool === 'pan' || (tool === 'select' && !shift)) return;
        created.userPanningEnabled(false);
        gesture.start(event.renderedPosition, shift);
      });
      created.on('tapdrag', (event) => {
        if (shiftPan !== undefined) {
          const at = pointer(event);
          created.pan({ x: shiftPan.pan.x + at.x - shiftPan.origin.x, y: shiftPan.pan.y + at.y - shiftPan.origin.y });
        } else {
          gesture.move(event.renderedPosition);
        }
      });
      const cancelBox = (): void => {
        if (shiftPan !== undefined) {
          shiftPan = undefined;
          created.userPanningEnabled(true);
        }
        if (!gesture.active) return;
        gesture.cancel();
        ignoreTap = true;
        created.userPanningEnabled(true);
      };
      created.on('tapend', (event) => {
        if (shiftPan !== undefined) {
          shiftPan = undefined;
          created.userPanningEnabled(true);
        }
        if (!gesture.active) return;
        if (!insideCanvas(event.renderedPosition)) {
          cancelBox();
          return;
        }
        gesture.end(event.renderedPosition);
        created.userPanningEnabled(true);
      });
      created.on('grab', (event) => {
        const node = event.target;
        dragging = { id: node.id(), start: { x: node.position('x'), y: node.position('y') }, tool, pinned: drawnPinned, cancelled: false };
      });
      created.on('drag', () => {
        if (dragging?.cancelled === true) created.getElementById(dragging.id).position({ ...dragging.start });
      });
      created.on('dragfree', (event) => {
        const drag = dragging;
        dragging = undefined;
        if (drag === undefined || drag.cancelled || event.target.id() !== drag.id) return;
        if (!insideCanvas(event.renderedPosition)) {
          event.target.position({ ...drag.start });
          return;
        }
        const position = { x: event.target.position('x'), y: event.target.position('y') };
        if (position.x !== drag.start.x || position.y !== drag.start.y) events.move({ id: drag.id, position });
      });
      created.on('free', () => {
        if (dragging?.cancelled === true) dragging = undefined;
      });
      created.on('cxttap', (event) => {
        const { target, originalEvent } = event;
        if (gesture.active || !(originalEvent instanceof MouseEvent)) return;
        const at = { x: originalEvent.clientX, y: originalEvent.clientY };
        if (target === created) events.contextMenu({ target: undefined, ...at });
        else if ('isNode' in target) events.contextMenu({ target: { kind: target.isNode() ? 'node' : 'relationship', key: target.id() }, ...at });
      });
      const restoreNativeMenu = container === undefined ? undefined : suppressNativeMenu(container);
      container?.addEventListener('pointercancel', cancelBox);
      container?.addEventListener('pointercancel', cancelDrag);
      const stopFollowing = container === undefined ? undefined : followSize(container, () => {
        if (core === created) {
          created.resize();
          dropTip();
        }
      });
      window.addEventListener('blur', cancelBox);
      window.addEventListener('blur', cancelDrag);
      teardown = () => {
        restoreNativeMenu?.();
        stopFollowing?.();
        container?.removeEventListener('pointercancel', cancelBox);
        container?.removeEventListener('pointercancel', cancelDrag);
        window.removeEventListener('blur', cancelBox);
        window.removeEventListener('blur', cancelDrag);
        dragging = undefined;
        gesture.cancel();
        overlay?.dispose();
        tip?.dispose();
        tip = undefined;
        syncTipNow = undefined;
        hovered = undefined;
        remembered = undefined;
        showCursor();
        surface = undefined;
      };
      reportFailure = events.failed;
      options.onCore?.(created);
      core = created;
      if (viewport !== undefined) showViewport(created, viewport);
      fitted = viewport !== undefined;
      fits = 0;
      paints = container !== undefined || options.paintCaption !== undefined;
      surfaced = container !== undefined;
    },
    draw(scene: Scene, restore?: Viewport) {
      const cy = requireCore();
      tool = scene.tool;
      let anotherSource = false;
      if (scene.source !== lastSource) {
        cancelDrag();
        if (lastSource !== undefined) {
          fitted = false;
          pendingReport = undefined;
          anotherSource = true;
        }
        lastSource = scene.source;
      }
      const wantedEntities = new Set(scene.entities.map((entity) => entity.id));
      const wantedRelationships = new Set(scene.relationships.map((relationship) => relationship.id));
      if (dragging !== undefined && (scene.tool !== dragging.tool || !sameKeys(scene.pinned, dragging.pinned) || !wantedEntities.has(dragging.id))) cancelDrag();
      drawnPinned = scene.pinned;
      let retained = 0;
      const hadEntities = cy.nodes().nonempty();
      cy.batch(() => {
        cy.edges().filter((edge) => !wantedRelationships.has(edge.id())).remove();
        cy.nodes().filter((node) => !wantedEntities.has(node.id())).remove();
        for (const entity of scene.entities) {
          const existing = cy.getElementById(entity.id);
          if (!existing.empty()) retained += 1;
          if (existing.empty()) cy.add({ group: 'nodes', data: { id: entity.id }, position: { ...entity.position }, ...(far ? { classes: 'far' } : {}) });
          else if ((dragging === undefined || dragging.cancelled || dragging.id !== entity.id) && (existing.position('x') !== entity.position.x || existing.position('y') !== entity.position.y)) existing.position({ ...entity.position });
          const node = cy.getElementById(entity.id);
          const remainder = entity.remainder === true;
          if (node.data('remainder') !== remainder) node.data('remainder', remainder);
          const grabbable = !remainder && scene.tool !== 'pan' && !scene.pinned.has(entity.id);
          if (node.grabbable() !== grabbable) {
            if (grabbable) node.grabify();
            else node.ungrabify();
          }
          const pinned = scene.pinned.has(entity.id);
          const lookKey = `${entity.look.iconKey}\u0000${entity.look.line1}\u0000${entity.look.line2}\u0000${pinned}`;
          if (node.data('lookKey') !== lookKey) {
            node.data({ lookKey, caption: `${entity.look.line1}\n${entity.look.line2}`, title: entity.look.tip?.title ?? entity.look.line1, detail: entity.look.tip?.detail ?? entity.look.line2 });
            if (paints) {
              const known = captions.get(captionKey(entity.look.line1, entity.look.line2));
              node.style('background-image', imagesFor(entity.look.iconKey, pinned, known));
              if (known === undefined) captionQueue.push({ id: entity.id, key: lookKey, iconKey: entity.look.iconKey, line1: entity.look.line1, line2: entity.look.line2, pinned });
            }
          }
        }
        for (const relationship of scene.relationships) {
          const existing = cy.getElementById(relationship.id);
          if (existing.empty()) cy.add({ group: 'edges', data: { id: relationship.id, source: relationship.from, target: relationship.to, remainder: relationship.remainder === true, ...edgeData(relationship.look) }, ...(far && relationship.look.label !== undefined ? { classes: 'far' } : {}) });
          else {
            existing.data(edgeData(relationship.look));
            if (existing.data('remainder') !== (relationship.remainder === true)) existing.data('remainder', relationship.remainder === true);
            if (far && relationship.look.label !== undefined) existing.addClass('far');
            if (existing.source().id() !== relationship.from || existing.target().id() !== relationship.to) existing.move({ source: relationship.from, target: relationship.to });
          }
        }
      });
      if (captionQueue.length > 0) scheduleCaptions();
      cy.batch(() => {
        for (const item of [...scene.entities, ...scene.relationships]) {
          const element = cy.getElementById(item.id);
          const selected = scene.selection.has(item.id);
          if (element.data('selected') !== selected) element.data('selected', selected);
          const focused = scene.focused === item.id;
          if (element.data('focused') !== focused) element.data('focused', focused);
          const ringed = focused && scene.focusRing !== false;
          if (element.data('ringed') !== ringed) element.data('ringed', ringed);
        }
      });
      if (hovered !== undefined && !wantedEntities.has(hovered)) hovered = undefined;
      if (scene.focused !== tipFocus) {
        tipFocus = scene.focused;
        if (scene.focused !== undefined) revealFocused(cy, scene.focused);
        tipHidden = false;
      }
      syncTipNow?.();
      if (remembered !== undefined && cy.getElementById(remembered).empty()) remembered = undefined;
      showCursor();
      syncFar(cy, true);
      const replaced = hadEntities && scene.entities.length > 0 && retained === 0;
      if (scene.view === 'fit' && scene.entities.length > 0 && (!fitted || replaced)) {
        if (restore !== undefined && (anotherSource || replaced)) showViewport(cy, restore);
        else {
          fitEntities(cy);
          fits += 1;
        }
        syncFar(cy, true);
      }
      if (scene.entities.length > 0) fitted = true;
    },
    show(viewport) {
      showViewport(requireCore(), viewport);
    },
    fit(entitiesOnly) {
      const cy = requireCore();
      if (cy.nodes().empty()) return;
      fitEntities(cy, entitiesOnly === true);
    },
    anchorOf(key) {
      const cy = requireCore();
      if (surface === undefined) return undefined;
      const rect = surface.getBoundingClientRect();
      if (key === undefined) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const entity = cy.nodes().toArray().find((node) => node.id() === key);
      const relationship = cy.edges().toArray().find((edge) => edge.id() === key);
      const at = entity !== undefined ? entity.renderedPosition() : relationship?.renderedMidpoint();
      return at === undefined ? undefined : { x: rect.left + at.x, y: rect.top + at.y };
    },
    centerOn(key) {
      const cy = requireCore();
      const element = cy.getElementById(key);
      if (!element.empty()) cy.center(element);
    },
    zoomBy(factor) {
      const cy = requireCore();
      cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    },
    inspect(): Inspection {
      const cy = requireCore();
      return {
        fits,
        viewport: { zoom: cy.zoom(), x: cy.pan().x, y: cy.pan().y },
        zoomLimits: { min: cy.minZoom(), max: cy.maxZoom() },
        boundingBox: cy.nodes().empty() ? undefined : cy.nodes().renderedBoundingBox({}),
        interaction: { panning: cy.userPanningEnabled(), zooming: cy.userZoomingEnabled(), boxSelecting: cy.boxSelectionEnabled(), nodesGrabbable: cy.nodes().map((node) => node.grabbable()).includes(true), nodesSelectable: !cy.autounselectify() },
        remainders: cy.nodes('[?remainder]').map((node) => ({ id: node.id(), caption: String(node.data('caption') ?? ''), grabbable: node.grabbable() })),
        nodes: cy.nodes('[!remainder]').map((node) => {
          const image = node.style('background-image');
          const layers = image === 'none' ? [] : image.split(' ');
          const opacities = String(node.style('background-image-opacity')).split(' ').map(Number);
          const shownAt = (layer: number): boolean => (opacities[layer] ?? 1) > 0;
          return { id: node.id(), diameter: parseFloat(node.style('width')), outline: node.style('border-color'), outlineWidth: parseFloat(node.style('border-width')), halo: parseFloat(node.style('underlay-opacity')) > 0, images: layers, caption: String(node.data('caption') ?? ''), captionShown: shownAt(1), glyphShown: shownAt(0), badgeShown: layers.length === 3 && shownAt(2), focused: parseFloat(node.style('outline-width')) > 0 };
        }),
        edges: cy.edges('[!remainder]').map((edge) => ({
          id: edge.id(),
          source: edge.source().id(),
          target: edge.target().id(),
          width: parseFloat(edge.style('width')),
          color: edge.style('line-color'),
          lineStyle: edge.style('line-style'),
          arrow: edge.style('target-arrow-shape'),
          label: edge.style('label'),
          labelOutline: parseFloat(edge.style('text-border-width')),
          labelShown: edge.style('label') !== '',
          lineShown: edge.style('display') !== 'none' && edge.style('visibility') === 'visible' && parseFloat(edge.style('opacity')) > 0 && parseFloat(edge.style('line-opacity')) > 0 && parseFloat(edge.style('width')) > 0,
          focused: parseFloat(edge.style('underlay-opacity')) > 0,
          lineOutline: parseFloat(edge.style('line-outline-width')),
        })),
      };
    },
    describe(): DrawnCounts {
      const cy = requireCore();
      return { entities: cy.nodes('[!remainder]').length, relationships: cy.edges('[!remainder]').length };
    },
    viewport() {
      const cy = requireCore();
      return { zoom: cy.zoom(), x: cy.pan().x, y: cy.pan().y };
    },
    positions() {
      return new Map(requireCore().nodes('[!remainder]').map((node) => [node.id(), { x: node.position('x'), y: node.position('y') }]));
    },
    dispose() {
      captionQueue = [];
      farQueue = [];
      reportFailure = () => undefined;
      flushViewport?.();
      flushViewport = undefined;
      teardown?.();
      teardown = undefined;
      core?.destroy();
      core = undefined;
    },
  };
}
