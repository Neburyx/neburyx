import cytoscape, { type Core, type StylesheetJson } from 'cytoscape';
import type { Position } from '../state/presentation-state.js';
import { CAPTION_HEIGHT, CAPTION_TOP, CAPTION_WIDTH } from './caption-layout.js';
import { paintCaption, type CaptionPainter } from './caption-painter.js';
import { glyphUri } from './glyphs.js';
import { AGGREGATE_WIDTH, ARROW_GAP, ARROW_SHAPE, DASH_PATTERN, DERIVED_COLOR, DOT_PATTERN, EDGE_COLOR, EDGE_WIDTH, FIT_PADDING, GLYPH_COLOR, GLYPH_SIZE, LABEL_FILL, LABEL_FONT_SIZE, NODE_DIAMETER, NODE_FILL, NODE_OUTLINE, NODE_OUTLINE_WIDTH, PILL_FILL, PILL_OUTLINE_WIDTH } from './look.js';
import type { RelationshipLook } from './relationship-look.js';
import type { CanvasRenderer, DrawnCounts, Inspection, Scene } from './scene.js';

// Panning, zooming, selecting and moving belong to later features; until they are built the drawing does not respond to the pointer.
const NO_INTERACTION = { userPanningEnabled: false, userZoomingEnabled: false, boxSelectionEnabled: false, autoungrabify: true, autounselectify: true };

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
];

export interface CytoscapeRendererOptions {
  readonly paintCaption?: CaptionPainter;
}

export function createCytoscapeRenderer(options: CytoscapeRendererOptions = {}): CanvasRenderer {
  let core: Core | undefined;
  let fitted = false;
  let fits = 0;
  let paints = false;
  const painter = options.paintCaption ?? paintCaption;
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

  return {
    mount(container) {
      if (core !== undefined) throw new Error('the renderer is already mounted');
      core = cytoscape({ container, headless: container === undefined, styleEnabled: true, style: STYLE, layout: { name: 'preset' }, ...NO_INTERACTION });
      fitted = false;
      fits = 0;
      paints = container !== undefined || options.paintCaption !== undefined;
    },
    draw(scene: Scene) {
      const cy = requireCore();
      const wantedEntities = new Set(scene.entities.map((entity) => entity.id));
      const wantedRelationships = new Set(scene.relationships.map((relationship) => relationship.id));
      const unplaced: string[] = [];
      let retained = 0;
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
      const freshGraph = scene.entities.length > 0 && retained === 0;
      if (scene.view === 'fit' && scene.entities.length > 0 && (!fitted || freshGraph)) {
        cy.fit(undefined, FIT_PADDING);
        fits += 1;
      }
      if (scene.entities.length > 0) fitted = true;
      return placed;
    },
    inspect(): Inspection {
      const cy = requireCore();
      return {
        fits,
        interaction: { panning: cy.userPanningEnabled(), zooming: cy.userZoomingEnabled(), boxSelecting: cy.boxSelectionEnabled(), nodesGrabbable: !cy.autoungrabify(), nodesSelectable: !cy.autounselectify() },
        nodes: cy.nodes().map((node) => {
          const image = node.style('background-image');
          return { id: node.id(), diameter: parseFloat(node.style('width')), outline: node.style('border-color'), images: image === 'none' ? [] : image.split(' '), caption: String(node.data('caption') ?? '') };
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
      core?.destroy();
      core = undefined;
    },
  };
}
