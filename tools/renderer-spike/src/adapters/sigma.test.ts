import { describe, expect, it } from 'vitest';
import { generateFixture } from '../fixture/generate.js';
import { adapterNames, createAdapter } from './registry.js';
import { EDGE_COLOR, TRANSPARENT, toGraph } from './sigma-graph.js';

describe('the Sigma.js adapter graph', () => {
  const fixture = generateFixture({ seed: 1 });
  const graph = toGraph(fixture);

  it('holds one node per fixture node and one edge per relationship', () => {
    expect(graph.order + graph.size).toBe(300);
  });

  it('gives every node the shape of its type icon and a type colour, and the neighbor aggregate chip a lower-bound label', () => {
    const shapes = new Set(graph.mapNodes((_id, attributes) => attributes.shape));
    expect(shapes.size).toBeGreaterThanOrEqual(3);
    const chip = graph.findNode((_id, attributes) => attributes.kind === 'neighborAggregate');
    expect(chip && graph.getNodeAttribute(chip, 'label')).toMatch(/^Type [A-D] · \d+ \/ ≥ 3,000$/);
  });

  it('turns the dashes on for derived edges only, and the plain line off for them', () => {
    const derived = graph.filterEdges((_id, attributes) => attributes.kind === 'derived');
    const sourced = graph.filterEdges((_id, attributes) => attributes.kind === 'sourced');
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((id) => graph.getEdgeAttribute(id, 'dashColor') === EDGE_COLOR && graph.getEdgeAttribute(id, 'color') === TRANSPARENT)).toBe(true);
    expect(sourced.every((id) => graph.getEdgeAttribute(id, 'dashColor') === TRANSPARENT && graph.getEdgeAttribute(id, 'color') === EDGE_COLOR)).toBe(true);
  });

  it('draws the aggregate relationship thicker with its count and a label background', () => {
    const [aggregate] = graph.filterEdges((_id, attributes) => attributes.kind === 'aggregate');
    expect(aggregate && graph.getEdgeAttribute(aggregate, 'label')).toMatch(/^rel-b · \d+$/);
    expect(aggregate && graph.getEdgeAttribute(aggregate, 'size')).toBeGreaterThan(2);
    expect(aggregate && graph.getEdgeAttribute(aggregate, 'labelBackgroundColor')).toBe('#ffffff');
  });
});

describe('the adapter registry', () => {
  it('names both renderers', () => {
    expect(adapterNames()).toEqual(['cytoscape', 'sigma']);
  });

  it('refuses an unknown name, including an inherited property name', async () => {
    await expect(createAdapter('webgl-magic', undefined)).rejects.toMatchObject({ code: 'ADAPTER_UNKNOWN' });
    await expect(createAdapter('toString', undefined)).rejects.toMatchObject({ code: 'ADAPTER_UNKNOWN' });
  });

  it('refuses the Sigma.js adapter without a browser container', async () => {
    await expect(createAdapter('sigma', undefined)).rejects.toMatchObject({ code: 'ADAPTER_NEEDS_BROWSER' });
  });

  it('creates the Cytoscape.js adapter headless', async () => {
    const adapter = await createAdapter('cytoscape', undefined);
    expect(adapter.name).toBe('cytoscape');
  });
});
