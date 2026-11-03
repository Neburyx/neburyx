import forceAtlas2 from 'graphology-layout-forceatlas2';
import Sigma from 'sigma';
import { layerDashed, layerPlain, sdfCircle, sdfDiamond, sdfSquare, sdfTriangle } from 'sigma/rendering';
import { AdapterError, type Drawing, type GroupState, type Position, type RendererAdapter, type ViewState } from '../adapter.js';
import { parseFixture } from '../fixture/generate.js';
import type { Additions, Fixture } from '../fixture/schema.js';
import { EDGE_COLOR, edgeAttributes, nodeAttributes, toGraph, type EdgeAttributes, type NodeAttributes } from './sigma-graph.js';

const LAYOUT_ITERATIONS = 150;
const DEFAULT_HEAD = 'arrow';
const CAMERA_CENTER = 0.5;
const FOCUS_COLOR = '#ffb000';
const FOCUS_PADDING = 6;
const ADDED_RING_RADIUS = 60;
const GOLDEN_ANGLE = 2.399963;
const DASH_SIZE = 6;
const GAP_SIZE = 4;
const LABEL_SIZE = 9;

const NOTES: readonly string[] = [
  'Node icons are the node shape (circle, square, triangle, diamond) in the type colour; a glyph inside a coloured disc needs a custom node layer written in GLSL (none written).',
  'Dashed relationships come from the built-in dashed edge layer; one edge attribute (the dash colour) turns the dashes on, and the plain layer is made transparent for those edges, because every layer draws every edge (workaround: five lines).',
  'The aggregate relationship label has a filled background but no outline: an outlined pill needs a custom label program (none written).',
  'The display data does not report the relationship head, so the arrow is read back from the declared default head, not from the renderer.',
  'A node label keeps its line break in the data but is drawn on one line, so the second line (type and state) shares the line of the reference (no workaround written).',
  'Sigma.js has no grouping or compound nodes; a group would be a hand-drawn hull layer or a layout that pulls a type together, none written.',
  'The focus ring is the built-in node backdrop, switched on by a node attribute (four lines).',
  'Sigma has no layout of its own; the adapter runs ForceAtlas2 from graphology-layout-forceatlas2.',
];

export interface SigmaAdapterOptions {
  readonly container: HTMLElement;
}

export function createSigmaAdapter(options: SigmaAdapterOptions): RendererAdapter {
  let renderer: Sigma<NodeAttributes, EdgeAttributes> | undefined;
  let current: Fixture | undefined;

  const requireRenderer = (): Sigma<NodeAttributes, EdgeAttributes> => {
    if (renderer === undefined) throw new AdapterError('ADAPTER_NOT_MOUNTED');
    return renderer;
  };

  return {
    name: 'sigma',
    notes: NOTES,
    holdMechanism: 'fixed node attribute (ForceAtlas2 skips fixed nodes) plus a position restore, because ForceAtlas2 writes positions back as 32-bit floats',
    mount(input) {
      if (renderer !== undefined) throw new AdapterError('ADAPTER_ALREADY_MOUNTED');
      const fixture = parseFixture(input);
      const graph = toGraph(fixture);
      forceAtlas2.assign(graph, { iterations: LAYOUT_ITERATIONS, settings: forceAtlas2.inferSettings(graph) });
      current = fixture;
      renderer = new Sigma(graph, options.container, {
        primitives: {
          nodes: { shapes: [sdfCircle(), sdfSquare(), sdfTriangle(), sdfDiamond()] },
          edges: {
            layers: [layerPlain({ color: { attribute: 'color', default: EDGE_COLOR } }), layerDashed({ dashSize: { value: DASH_SIZE, mode: 'pixels' }, gapSize: { value: GAP_SIZE, mode: 'pixels' }, dashColor: { attribute: 'dashColor', default: EDGE_COLOR } })],
            defaultHead: DEFAULT_HEAD,
            variables: { dashColor: { type: 'color', default: EDGE_COLOR } },
          },
        },
        styles: {
          nodes: { backdropVisibility: { whenData: { focused: true }, then: 'visible', else: 'hidden' }, backdropColor: FOCUS_COLOR, backdropPadding: FOCUS_PADDING, x: { attribute: 'x' }, y: { attribute: 'y' }, size: { attribute: 'size' }, color: { attribute: 'color' }, shape: { attribute: 'shape' }, label: { attribute: 'label' }, labelVisibility: 'visible', labelSize: LABEL_SIZE, labelColor: '#1b1b1b' },
          edges: { dashColor: { attribute: 'dashColor' }, size: { attribute: 'size' }, color: { attribute: 'color' }, label: { attribute: 'label' }, labelVisibility: 'visible', labelSize: LABEL_SIZE, labelColor: '#1b1b1b', labelBackgroundColor: { attribute: 'labelBackgroundColor', defaultValue: 'rgba(255,255,255,0)' }, labelBackgroundPadding: 3 },
        },
        settings: { renderEdgeLabels: true, renderLabels: true },
      });
    },
    describe(): Drawing {
      const current = requireRenderer();
      const graph = current.getGraph();
      return {
        nodes: graph.mapNodes((id, attributes) => {
          const display = current.getNodeDisplayData(id);
          return {
            id,
            kind: attributes.kind === 'neighborAggregate' ? 'neighborAggregate' : 'entity',
            label: display?.label ?? '',
            iconKey: iconKeyFromShape(display?.shape),
            iconDrawn: display?.shape !== undefined,
            color: display?.color ?? '',
            dashedBorder: false,
          };
        }),
        relationships: graph.mapEdges((id, attributes) => {
          const display = current.getEdgeDisplayData(id);
          return {
            id,
            kind: relationshipKind(attributes.kind),
            lineStyle: attributes.dashColor === EDGE_COLOR ? 'dashed' : 'solid',
            width: display?.size ?? 0,
            label: display?.label ?? '',
            labelOutlined: false,
            hasArrow: (display?.head ?? DEFAULT_HEAD) !== 'none',
          };
        }),
      };
    },
    applyView(view: ViewState) {
      requireRenderer().getCamera().setState({ x: CAMERA_CENTER + view.offsetX, y: CAMERA_CENTER + view.offsetY, ratio: 1 / view.zoomFactor, angle: 0 });
    },
    getPositions() {
      const positions = new Map<string, Position>();
      requireRenderer().getGraph().forEachNode((id, attributes) => positions.set(id, { x: attributes.x, y: attributes.y }));
      return positions;
    },
    setPositions(positions) {
      const active = requireRenderer();
      for (const [id, position] of positions) {
        active.getGraph().setNodeAttribute(id, 'x', position.x);
        active.getGraph().setNodeAttribute(id, 'y', position.y);
      }
      active.refresh();
    },
    fix(ids) {
      const graph = requireRenderer().getGraph();
      for (const id of ids) graph.setNodeAttribute(id, 'fixed', true);
    },
    addNodes(additions: Additions) {
      const active = requireRenderer();
      if (current === undefined) throw new AdapterError('ADAPTER_NOT_MOUNTED');
      const fixture = current;
      const graph = active.getGraph();
      additions.nodes.forEach((node, index) => {
        const anchor = additions.relationships.find((relationship) => relationship.to === node.id)?.from;
        const origin = anchor === undefined ? { x: 0, y: 0 } : { x: graph.getNodeAttribute(anchor, 'x'), y: graph.getNodeAttribute(anchor, 'y') };
        const angle = index * GOLDEN_ANGLE;
        graph.addNode(node.id, nodeAttributes(fixture, node, { x: origin.x + ADDED_RING_RADIUS * Math.cos(angle), y: origin.y + ADDED_RING_RADIUS * Math.sin(angle) }));
      });
      for (const relationship of additions.relationships) graph.addEdgeWithKey(relationship.id, relationship.from, relationship.to, edgeAttributes(relationship));
      const held = graph.filterNodes((_id, attributes) => attributes.fixed === true).map((id) => ({ id, x: graph.getNodeAttribute(id, 'x'), y: graph.getNodeAttribute(id, 'y') }));
      forceAtlas2.assign(graph, { iterations: LAYOUT_ITERATIONS, settings: forceAtlas2.inferSettings(graph) });
      for (const node of held) {
        graph.setNodeAttribute(node.id, 'x', node.x);
        graph.setNodeAttribute(node.id, 'y', node.y);
      }
      active.refresh();
    },
    groupByType() {
      throw new AdapterError('ADAPTER_UNSUPPORTED');
    },
    ungroupByType() {
      throw new AdapterError('ADAPTER_UNSUPPORTED');
    },
    groups(): readonly GroupState[] {
      return [];
    },
    setFocus(id) {
      const active = requireRenderer();
      const graph = active.getGraph();
      graph.forEachNode((node, attributes) => {
        if (attributes.focused === true) graph.setNodeAttribute(node, 'focused', false);
      });
      if (id !== undefined) {
        if (!graph.hasNode(id)) throw new AdapterError('ADAPTER_NODE_UNKNOWN');
        graph.setNodeAttribute(id, 'focused', true);
      }
      active.refresh();
    },
    isFocusRingVisible(id) {
      return requireRenderer().getNodeDisplayData(id)?.backdropVisibility === 'visible';
    },
    dispose() {
      renderer?.kill();
      renderer = undefined;
      current = undefined;
    },
  };
}

function iconKeyFromShape(shape: string | undefined): 'circle' | 'square' | 'triangle' | 'diamond' {
  return shape === 'square' || shape === 'triangle' || shape === 'diamond' ? shape : 'circle';
}

function relationshipKind(value: unknown): 'sourced' | 'derived' | 'aggregate' {
  return value === 'derived' || value === 'aggregate' ? value : 'sourced';
}
