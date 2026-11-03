import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import { AdapterError, type Drawing, type GroupState, type Position, type RendererAdapter, type ViewState } from '../adapter.js';
import { parseFixture } from '../fixture/generate.js';
import type { Additions, Fixture, FixtureNode, FixtureRelationship } from '../fixture/schema.js';
import { iconDataUri, iconKeyOf, initialPositions, nodeLabel, relationshipLabel, typeColor, typeDisplayName } from '../look.js';

const NODE_SIZE = 44;
const AGGREGATE_NODE_WIDTH = 110;
const AGGREGATE_NODE_HEIGHT = 36;
const SOURCED_WIDTH = 1.5;
const AGGREGATE_WIDTH = 4;
const FONT = 'ui-monospace, monospace';
const ORIGIN: Position = { x: 0, y: 0 };
const FIT_PADDING = 30;
const ADDED_RING_RADIUS = 60;
const GOLDEN_ANGLE = 2.399963;

const NOTES: readonly string[] = [
  'A node label uses one font for both lines, so the reference and the second line cannot differ in face.',
  'Dashed relationships, the outlined pill label and the dashed aggregate border are built-in style properties.',
  'Grouping is built in: compound parents (node.move({ parent })), about ten lines in the adapter.',
  'The focus ring is a class with a border style (three lines); the keyboard itself is not handled by the library.',
];

function nodeElement(fixture: Fixture, node: FixtureNode, position: Position): ElementDefinition {
  const iconKey = iconKeyOf(fixture, node.type);
  return {
    group: 'nodes',
    data: { id: node.id, kind: node.kind, type: node.type, label: nodeLabel(fixture, node), iconKey, iconUri: iconDataUri(iconKey), color: typeColor(fixture, node.type) },
    position: { x: position.x, y: position.y },
  };
}

function edgeElement(relationship: FixtureRelationship): ElementDefinition {
  return { group: 'edges', data: { id: relationship.id, kind: relationship.kind, source: relationship.from, target: relationship.to, label: relationshipLabel(relationship) } };
}

function toElements(fixture: Fixture): ElementDefinition[] {
  const positions = initialPositions(fixture);
  return [...fixture.nodes.map((node) => nodeElement(fixture, node, positions.get(node.id) ?? ORIGIN)), ...fixture.relationships.map(edgeElement)];
}

const GROUP_PREFIX = 'group:';
const FOCUS_RING_WIDTH = 4;
const FOCUS_RING_COLOR = '#ffb000';

const STYLE: cytoscape.StylesheetJson = [
  {
    selector: 'node',
    style: {
      width: NODE_SIZE,
      height: NODE_SIZE,
      'background-color': 'data(color)',
      'background-image': 'data(iconUri)',
      'background-width': '60%',
      'background-height': '60%',
      'background-position-x': '50%',
      'background-position-y': '50%',
      'background-repeat': 'no-repeat',
      color: '#1b1b1b',
      label: 'data(label)',
      'font-family': FONT,
      'font-size': 9,
      'text-wrap': 'wrap',
      'text-valign': 'bottom',
      'text-margin-y': 4,
    },
  },
  {
    selector: 'node[kind = "neighborAggregate"]',
    style: { shape: 'round-rectangle', width: AGGREGATE_NODE_WIDTH, height: AGGREGATE_NODE_HEIGHT, 'border-width': 2, 'border-style': 'dashed', 'border-color': '#444444', 'background-image': 'none', 'text-valign': 'center', 'text-margin-y': 0, color: '#ffffff' },
  },
  {
    selector: 'edge',
    style: { width: SOURCED_WIDTH, 'line-style': 'solid', 'line-color': '#777777', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#777777', 'curve-style': 'bezier', label: 'data(label)', 'font-family': FONT, 'font-size': 8 },
  },
  { selector: 'node[kind = "group"]', style: { shape: 'round-rectangle', 'background-opacity': 0.08, 'background-image': 'none', 'border-width': 1, 'border-style': 'solid', 'border-color': '#888888', 'text-valign': 'top', 'text-margin-y': -4 } },
  { selector: 'node.focused', style: { 'border-width': FOCUS_RING_WIDTH, 'border-style': 'solid', 'border-color': FOCUS_RING_COLOR } },
  { selector: 'edge[kind = "derived"]', style: { 'line-style': 'dashed' } },
  {
    selector: 'edge[kind = "aggregate"]',
    style: { width: AGGREGATE_WIDTH, 'text-background-color': '#ffffff', 'text-background-opacity': 1, 'text-background-shape': 'roundrectangle', 'text-background-padding': '3px', 'text-border-width': 1, 'text-border-style': 'solid', 'text-border-color': '#444444', 'text-border-opacity': 1 },
  },
];

/** `core.pan()` returns the live pan object, so the values are copied. */
function captureView(core: Core): { readonly zoom: number; readonly pan: { readonly x: number; readonly y: number } } {
  const { x, y } = core.pan();
  return { zoom: core.zoom(), pan: { x, y } };
}

export interface CytoscapeAdapterOptions {
  readonly container: HTMLElement | undefined;
}

export function createCytoscapeAdapter(options: CytoscapeAdapterOptions): RendererAdapter {
  let cy: Core | undefined;
  let current: Fixture | undefined;
  let fitView: { readonly zoom: number; readonly pan: { readonly x: number; readonly y: number } } | undefined;

  const requireFixture = (): Fixture => {
    if (current === undefined) throw new AdapterError('ADAPTER_NOT_MOUNTED');
    return current;
  };

  const requireCore = (): Core => {
    if (cy === undefined) throw new AdapterError('ADAPTER_NOT_MOUNTED');
    return cy;
  };

  return {
    name: 'cytoscape',
    notes: NOTES,
    holdMechanism: 'built-in lock (node.lock(), which the cose layout honours)',
    mount(input) {
      if (cy !== undefined) throw new AdapterError('ADAPTER_ALREADY_MOUNTED');
      const fixture = parseFixture(input);
      const core = cytoscape({ container: options.container, headless: options.container === undefined, styleEnabled: true, elements: toElements(fixture), style: STYLE, layout: { name: 'preset' } });
      core.layout({ name: 'cose', animate: false, randomize: false, fit: true, padding: FIT_PADDING }).run();
      fitView = captureView(core);
      current = fixture;
      cy = core;
    },
    describe(): Drawing {
      const core = requireCore();
      return {
        nodes: core.nodes('[kind != "group"]').map((node) => ({
          id: node.id(),
          kind: node.data('kind') === 'neighborAggregate' ? 'neighborAggregate' : 'entity',
          label: node.style('label'),
          iconKey: iconKeyOfData(node.data('iconKey')),
          iconDrawn: node.style('background-image') !== 'none',
          color: node.style('background-color'),
          dashedBorder: node.style('border-style') === 'dashed' && parseFloat(node.style('border-width')) > 0,
        })),
        relationships: core.edges().map((edge) => ({
          id: edge.id(),
          kind: relationshipKind(edge.data('kind')),
          lineStyle: edge.style('line-style') === 'dashed' ? 'dashed' : 'solid',
          width: parseFloat(edge.style('width')),
          label: edge.style('label'),
          labelOutlined: parseFloat(edge.style('text-border-width')) > 0,
          hasArrow: edge.style('target-arrow-shape') !== 'none',
        })),
      };
    },
    applyView(view: ViewState) {
      const core = requireCore();
      if (fitView === undefined) throw new AdapterError('ADAPTER_NOT_MOUNTED');
      core.viewport({ zoom: fitView.zoom * view.zoomFactor, pan: { x: fitView.pan.x + view.offsetX * core.width(), y: fitView.pan.y + view.offsetY * core.height() } });
    },
    getPositions() {
      const positions = new Map<string, Position>();
      for (const node of requireCore().nodes()) positions.set(node.id(), { x: node.position('x'), y: node.position('y') });
      return positions;
    },
    setPositions(positions) {
      const core = requireCore();
      for (const [id, position] of positions) core.getElementById(id).position({ x: position.x, y: position.y });
    },
    fix(ids) {
      const core = requireCore();
      for (const id of ids) core.getElementById(id).lock();
    },
    addNodes(additions: Additions) {
      const core = requireCore();
      if (current === undefined) throw new AdapterError('ADAPTER_NOT_MOUNTED');
      const fixture = current;
      const elements = [
        ...additions.nodes.map((node, index) => {
          const anchor = additions.relationships.find((relationship) => relationship.to === node.id)?.from;
          const origin = anchor === undefined ? ORIGIN : core.getElementById(anchor).position();
          const angle = index * GOLDEN_ANGLE;
          return nodeElement(fixture, node, { x: origin.x + ADDED_RING_RADIUS * Math.cos(angle), y: origin.y + ADDED_RING_RADIUS * Math.sin(angle) });
        }),
        ...additions.relationships.map(edgeElement),
      ];
      core.add(elements);
      core.layout({ name: 'cose', animate: false, randomize: false, fit: false }).run();
      core.fit(undefined, FIT_PADDING);
      fitView = captureView(core);
    },
    groupByType(typeId) {
      const core = requireCore();
      const members = core.nodes(`[type = "${typeId}"]`).filter('[kind = "entity"]');
      if (members.empty()) throw new AdapterError('ADAPTER_GROUP_EMPTY');
      const groupId = `${GROUP_PREFIX}${typeId}`;
      if (core.getElementById(groupId).nonempty()) return;
      core.add({ group: 'nodes', data: { id: groupId, kind: 'group', typeId, label: `${typeDisplayName(requireFixture(), typeId)} group` } });
      members.move({ parent: groupId });
    },
    ungroupByType(typeId) {
      const core = requireCore();
      const group = core.getElementById(`${GROUP_PREFIX}${typeId}`);
      if (group.empty()) return;
      group.children().move({ parent: null });
      group.remove();
    },
    groups() {
      return requireCore().nodes('[kind = "group"]').map((group): GroupState => ({ typeId: String(group.data('typeId')), members: group.children().length }));
    },
    setFocus(id) {
      const core = requireCore();
      core.nodes('.focused').removeClass('focused');
      if (id === undefined) return;
      const node = core.getElementById(id);
      if (node.empty()) throw new AdapterError('ADAPTER_NODE_UNKNOWN');
      node.addClass('focused');
    },
    isFocusRingVisible(id) {
      const node = requireCore().getElementById(id);
      return node.hasClass('focused') && parseFloat(node.style('border-width')) >= FOCUS_RING_WIDTH && node.style('border-color') !== '';
    },
    dispose() {
      cy?.destroy();
      cy = undefined;
      fitView = undefined;
      current = undefined;
    },
  };
}

function iconKeyOfData(value: unknown): 'circle' | 'square' | 'triangle' | 'diamond' {
  return value === 'square' || value === 'triangle' || value === 'diamond' ? value : 'circle';
}

function relationshipKind(value: unknown): 'sourced' | 'derived' | 'aggregate' {
  return value === 'derived' || value === 'aggregate' ? value : 'sourced';
}
