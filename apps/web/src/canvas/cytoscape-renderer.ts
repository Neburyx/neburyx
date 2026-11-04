import cytoscape, { type Core, type StylesheetJson } from 'cytoscape';
import type { PointerTool, Position } from '../state/presentation-state.js';
import { CAPTION_HEIGHT, CAPTION_TOP, CAPTION_WIDTH } from './caption-layout.js';
import { paintCaption, type CaptionPainter } from './caption-painter.js';
import { glyphUri } from './glyphs.js';
import { AGGREGATE_WIDTH, ARROW_GAP, ARROW_SHAPE, DASH_PATTERN, DERIVED_COLOR, DOT_PATTERN, EDGE_COLOR, EDGE_WIDTH, FIT_PADDING, GLYPH_COLOR, GLYPH_SIZE, LABEL_FILL, LABEL_FONT_SIZE, NODE_DIAMETER, NODE_FILL, NODE_OUTER_DIAMETER, NODE_OUTLINE, NODE_OUTLINE_WIDTH, PILL_FILL, PILL_OUTLINE_WIDTH, SELECTED_COLOR, SELECTED_HALO_COLOR, SELECTED_HALO_OPACITY, SELECTED_HALO_PADDING, SELECTED_LINE_EXTRA, SELECTED_OUTLINE_WIDTH } from './look.js';
import type { RelationshipLook } from './relationship-look.js';
import { createBoxGesture, type BoxOverlay } from './box-gesture.js';
import { createBoxOverlay } from './box-overlay.js';
import { fitViewport, type Size } from './fit.js';
import { suppressNativeMenu } from './native-menu.js';
import { ZOOM_MAX, ZOOM_MIN } from './zoom.js';
import type { CanvasRenderer, DrawnCounts, Inspection, Scene } from './scene.js';

// Entities are neither dragged nor selected by the library: clicks and boxes are reported and decided by the caller.
const POINTER = { userPanningEnabled: true, userZoomingEnabled: true, boxSelectionEnabled: false, autoungrabify: true, autounselectify: true };

const edgeData = (look: RelationshipLook) => ({ aggregate: look.aggregate, origin: look.origin, label: look.label ?? '' });


// Cytoscape keeps the object it is given as the node's position and writes to it, so every position is copied in.
const ORIGIN: Position = { x: 0, y: 0 };
const SPIRAL_STEP = 40;
const GOLDEN_ANGLE = 2.399963;

const STYLE: StylesheetJson = [
  {
    selector: 'node',
    style: {
      width: NODE_DIAMETER,
      height: NODE_DIAMETER,
      'background-color': NODE_FILL,
      'border-width': NODE_OUTLINE_WIDTH,
      'border-color': NODE_OUTLINE,
      // the glyph sits inside the disc and the caption hangs below it, so the second image is drawn over the node, not clipped to it
      'background-width': [`${GLYPH_SIZE}px`, `${CAPTION_WIDTH}px`],
      'background-height': [`${GLYPH_SIZE}px`, `${CAPTION_HEIGHT}px`],
      'background-position-x': ['50%', '50%'],
      'background-position-y': ['50%', `${CAPTION_TOP}px`],
      'background-fit': ['none', 'none'],
      'background-repeat': ['no-repeat', 'no-repeat'],
      'background-image-containment': ['inside', 'over'],
      'background-clip': ['node', 'none'],
      'bounds-expansion': CAPTION_WIDTH / 2,
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
    },
  },
  {
    selector: 'edge[origin = "derived"]',
    style: { 'line-color': DERIVED_COLOR, 'line-style': 'dashed', 'line-dash-pattern': DASH_PATTERN, 'target-arrow-shape': 'none' },
  },
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
  { selector: 'edge[?selected]', style: { 'line-color': SELECTED_COLOR, 'target-arrow-color': SELECTED_COLOR, width: EDGE_WIDTH + SELECTED_LINE_EXTRA } },
  { selector: 'edge[?selected][?aggregate]', style: { width: AGGREGATE_WIDTH + SELECTED_LINE_EXTRA } },
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
  // The ticket of the one viewport report that waits for its frame; a source change drops it, and only the frame that holds the current ticket reports.
  let pendingReport: number | undefined;
  let tickets = 0;
  const captions = new Map<string, string>();
  const captionFor = (line1: string, line2: string): string => {
    const key = `${line1}\u0000${line2}`;
    const known = captions.get(key);
    if (known !== undefined) return known;
    const painted = painter(line1, line2);
    captions.set(key, painted);
    return painted;
  };

  const requireCore = (): Core => {
    if (core === undefined) throw new Error('the renderer is not mounted');
    return core;
  };

  // A fit shows every entity even when that needs a zoom below the minimum; the minimum then follows the fit, so the wheel cannot zoom out further and zooming in moves toward the range.
  // A drawing with no canvas element has no size of its own (the library reports 1 x 1), so it has none unless a caller says one.
  const sizeOf = (cy: Core): Size => options.canvasSize?.() ?? (surfaced ? { width: cy.width(), height: cy.height() } : { width: 0, height: 0 });

  const fitEntities = (cy: Core): void => {
    const viewport = fitViewport(cy.nodes().boundingBox({}), sizeOf(cy), FIT_PADDING);
    if (viewport === undefined) return;
    cy.minZoom(Math.min(ZOOM_MIN, viewport.zoom));
    cy.viewport({ zoom: viewport.zoom, pan: { x: viewport.x, y: viewport.y } });
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
      created.on('cxttap', (event) => {
        const { target, originalEvent } = event;
        if (gesture.active || !(originalEvent instanceof MouseEvent)) return;
        const at = { x: originalEvent.clientX, y: originalEvent.clientY };
        if (target === created) events.contextMenu({ target: undefined, ...at });
        else if ('isNode' in target) events.contextMenu({ target: { kind: target.isNode() ? 'node' : 'relationship', key: target.id() }, ...at });
      });
      const restoreNativeMenu = container === undefined ? undefined : suppressNativeMenu(container);
      container?.addEventListener('pointercancel', cancelBox);
      window.addEventListener('blur', cancelBox);
      teardown = () => {
        restoreNativeMenu?.();
        container?.removeEventListener('pointercancel', cancelBox);
        window.removeEventListener('blur', cancelBox);
        gesture.cancel();
        overlay?.dispose();
      };
      options.onCore?.(created);
      core = created;
      if (viewport !== undefined) {
        created.minZoom(Math.min(ZOOM_MIN, viewport.zoom));
        created.viewport({ zoom: viewport.zoom, pan: { x: viewport.x, y: viewport.y } });
      }
      fitted = viewport !== undefined;
      fits = 0;
      paints = container !== undefined || options.paintCaption !== undefined;
      surfaced = container !== undefined;
    },
    draw(scene: Scene) {
      const cy = requireCore();
      tool = scene.tool;
      if (scene.source !== lastSource) {
        if (lastSource !== undefined) {
          fitted = false;
          pendingReport = undefined;
        }
        lastSource = scene.source;
      }
      const wantedEntities = new Set(scene.entities.map((entity) => entity.id));
      const wantedRelationships = new Set(scene.relationships.map((relationship) => relationship.id));
      const unplaced: string[] = [];
      let retained = 0;
      const hadEntities = cy.nodes().nonempty();
      cy.batch(() => {
        cy.edges().filter((edge) => !wantedRelationships.has(edge.id())).remove();
        cy.nodes().filter((node) => !wantedEntities.has(node.id())).remove();
        for (const entity of scene.entities) {
          const existing = cy.getElementById(entity.id);
          if (!existing.empty()) retained += 1;
          if (existing.empty()) cy.add({ group: 'nodes', data: { id: entity.id }, position: { ...(entity.position ?? ORIGIN) } });
          else if (entity.position !== undefined && (existing.position('x') !== entity.position.x || existing.position('y') !== entity.position.y)) existing.position(entity.position);
          if (entity.position === undefined) unplaced.push(entity.id);
          const node = cy.getElementById(entity.id);
          const lookKey = `${entity.look.iconKey}\u0000${entity.look.line1}\u0000${entity.look.line2}`;
          if (node.data('lookKey') !== lookKey) {
            node.data({ lookKey, caption: `${entity.look.line1}\n${entity.look.line2}` });
            if (paints) node.style('background-image', [glyphUri(entity.look.iconKey, GLYPH_COLOR), captionFor(entity.look.line1, entity.look.line2)]);
          }
        }
        for (const relationship of scene.relationships) {
          const existing = cy.getElementById(relationship.id);
          if (existing.empty()) cy.add({ group: 'edges', data: { id: relationship.id, source: relationship.from, target: relationship.to, ...edgeData(relationship.look) } });
          else {
            existing.data(edgeData(relationship.look));
            if (existing.source().id() !== relationship.from || existing.target().id() !== relationship.to) existing.move({ source: relationship.from, target: relationship.to });
          }
        }
      });
      cy.batch(() => {
        for (const item of [...scene.entities, ...scene.relationships]) {
          const element = cy.getElementById(item.id);
          const selected = scene.selection.has(item.id);
          if (element.data('selected') !== selected) element.data('selected', selected);
        }
      });
      const placed = new Map<string, Position>();
      if (unplaced.length > 0) {
        const held = cy.nodes().filter((node) => !unplaced.includes(node.id()));
        unplaced.forEach((id, index) => {
          const radius = SPIRAL_STEP * Math.sqrt(index + 1);
          cy.getElementById(id).position({ x: radius * Math.cos(index * GOLDEN_ANGLE), y: radius * Math.sin(index * GOLDEN_ANGLE) });
        });
        held.lock();
        cy.layout({ name: 'cose', animate: false, randomize: false, fit: false }).run();
        held.unlock();
        for (const id of unplaced) {
          const { x, y } = cy.getElementById(id).position();
          placed.set(id, { x, y });
        }
      }
      const replaced = hadEntities && scene.entities.length > 0 && retained === 0;
      if (scene.view === 'fit' && scene.entities.length > 0 && (!fitted || replaced)) {
        fitEntities(cy);
        fits += 1;
      }
      if (scene.entities.length > 0) fitted = true;
      return placed;
    },
    fit() {
      const cy = requireCore();
      if (cy.nodes().empty()) return;
      fitEntities(cy);
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
        interaction: { panning: cy.userPanningEnabled(), zooming: cy.userZoomingEnabled(), boxSelecting: cy.boxSelectionEnabled(), nodesGrabbable: !cy.autoungrabify(), nodesSelectable: !cy.autounselectify() },
        nodes: cy.nodes().map((node) => {
          const image = node.style('background-image');
          return { id: node.id(), diameter: parseFloat(node.style('width')), outline: node.style('border-color'), outlineWidth: parseFloat(node.style('border-width')), halo: parseFloat(node.style('underlay-opacity')) > 0, images: image === 'none' ? [] : image.split(' '), caption: String(node.data('caption') ?? '') };
        }),
        edges: cy.edges().map((edge) => ({
          id: edge.id(),
          source: edge.source().id(),
          target: edge.target().id(),
          width: parseFloat(edge.style('width')),
          color: edge.style('line-color'),
          lineStyle: edge.style('line-style'),
          arrow: edge.style('target-arrow-shape'),
          label: edge.style('label'),
          labelOutline: parseFloat(edge.style('text-border-width')),
        })),
      };
    },
    describe(): DrawnCounts {
      const cy = requireCore();
      return { entities: cy.nodes().length, relationships: cy.edges().length };
    },
    dispose() {
      flushViewport?.();
      flushViewport = undefined;
      teardown?.();
      teardown = undefined;
      core?.destroy();
      core = undefined;
    },
  };
}
