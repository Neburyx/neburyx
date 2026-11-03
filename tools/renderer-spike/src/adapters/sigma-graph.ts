import Graph from 'graphology';
import type { Fixture, FixtureNode, FixtureRelationship } from '../fixture/schema.js';
import { iconKeyOf, initialPositions, nodeLabel, relationshipLabel, typeColor } from '../look.js';

export const EDGE_COLOR = '#777777';
export const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const NODE_SIZE = 8;
const AGGREGATE_NODE_SIZE = 10;
const SOURCED_SIZE = 1.5;
const AGGREGATE_SIZE = 4;

export interface NodeAttributes {
  x: number;
  y: number;
  size: number;
  color: string;
  shape: string;
  label: string;
  kind: string;
  fixed?: boolean;
  focused?: boolean;
}

export interface EdgeAttributes {
  size: number;
  color: string;
  label: string;
  kind: string;
  dashColor: string;
  labelBackgroundColor?: string;
}

const SHAPE_BY_ICON: Readonly<Record<string, string>> = { circle: 'circle', square: 'square', triangle: 'triangle', diamond: 'diamond' };

export function nodeAttributes(fixture: Fixture, node: FixtureNode, position: { readonly x: number; readonly y: number }): NodeAttributes {
  const aggregate = node.kind === 'neighborAggregate';
  return {
    x: position.x,
    y: position.y,
    size: aggregate ? AGGREGATE_NODE_SIZE : NODE_SIZE,
    color: typeColor(fixture, node.type),
    shape: aggregate ? 'square' : (SHAPE_BY_ICON[iconKeyOf(fixture, node.type)] ?? 'circle'),
    label: nodeLabel(fixture, node),
    kind: node.kind,
  };
}

export function edgeAttributes(relationship: FixtureRelationship): EdgeAttributes {
  const derived = relationship.kind === 'derived';
  return {
    size: relationship.kind === 'aggregate' ? AGGREGATE_SIZE : SOURCED_SIZE,
    color: derived ? TRANSPARENT : EDGE_COLOR,
    dashColor: derived ? EDGE_COLOR : TRANSPARENT,
    label: relationshipLabel(relationship),
    kind: relationship.kind,
    ...(relationship.kind === 'aggregate' ? { labelBackgroundColor: '#ffffff' } : {}),
  };
}

export function toGraph(fixture: Fixture): Graph<NodeAttributes, EdgeAttributes> {
  const graph = new Graph<NodeAttributes, EdgeAttributes>({ type: 'directed', multi: true });
  const positions = initialPositions(fixture);
  for (const node of fixture.nodes) graph.addNode(node.id, nodeAttributes(fixture, node, positions.get(node.id) ?? { x: 0, y: 0 }));
  for (const relationship of fixture.relationships) graph.addEdgeWithKey(relationship.id, relationship.from, relationship.to, edgeAttributes(relationship));
  return graph;
}
