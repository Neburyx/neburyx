import type Graph from 'graphology';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateFixture } from '../fixture/generate.js';
import type { EdgeAttributes, NodeAttributes } from './sigma-graph.js';

const constructed = vi.hoisted(() => ({ count: 0 }));

vi.mock('sigma', () => ({
  default: class {
    private readonly graph: Graph<NodeAttributes, EdgeAttributes>;

    constructor(graph: Graph<NodeAttributes, EdgeAttributes>) {
      constructed.count += 1;
      this.graph = graph;
    }

    getGraph(): Graph<NodeAttributes, EdgeAttributes> {
      return this.graph;
    }

    getNodeDisplayData(id: string): { label: string; shape: string; color: string } {
      const attributes = this.graph.getNodeAttributes(id);
      return { label: attributes.label, shape: attributes.shape, color: attributes.color };
    }

    getEdgeDisplayData(id: string): { label: string; size: number } {
      const attributes = this.graph.getEdgeAttributes(id);
      return { label: attributes.label, size: attributes.size };
    }

    getCamera(): { setState: () => void } {
      return { setState: () => undefined };
    }

    refresh(): void {}

    kill(): void {}
  },
}));
vi.mock('sigma/rendering', () => ({ layerDashed: () => ({}), layerPlain: () => ({}), sdfCircle: () => ({}), sdfSquare: () => ({}), sdfTriangle: () => ({}), sdfDiamond: () => ({}) }));

async function adapter() {
  const { createSigmaAdapter } = await import('./sigma.js');
  const container: HTMLElement = Object.create(null);
  return createSigmaAdapter({ container });
}

beforeEach(() => {
  constructed.count = 0;
});

describe('the Sigma.js adapter, with the renderer replaced and no browser', () => {
  it('says grouping is unsupported, with a named error, for any type, and reports no groups', async () => {
    const sigma = await adapter();
    expect(() => sigma.groupByType('type-b')).toThrowError(expect.objectContaining({ code: 'ADAPTER_UNSUPPORTED' }));
    expect(() => sigma.ungroupByType('type-b')).toThrowError(expect.objectContaining({ code: 'ADAPTER_UNSUPPORTED' }));
    expect(sigma.groups()).toEqual([]);
  });

  it('answers unsupported for a type with no nodes too, and the picture is unchanged', async () => {
    const sigma = await adapter();
    sigma.mount(generateFixture({ seed: 1 }));
    const before = sigma.describe();
    expect(() => sigma.groupByType('type-z')).toThrowError(expect.objectContaining({ code: 'ADAPTER_UNSUPPORTED' }));
    expect(sigma.describe()).toEqual(before);
    expect(sigma.groups()).toEqual([]);
  });

  it('refuses a fixture that fails its schema with the same named error as the other adapter, builds no renderer and draws nothing', async () => {
    const sigma = await adapter();
    const broken = { ...generateFixture({ seed: 1 }), nodes: [] };
    expect(() => sigma.mount(broken)).toThrowError(expect.objectContaining({ code: 'FIXTURE_INVALID' }));
    expect(constructed.count).toBe(0);
    expect(() => sigma.describe()).toThrowError(expect.objectContaining({ code: 'ADAPTER_NOT_MOUNTED' }));
  });

  it('refuses a second mount before dispose and can be mounted again after it', async () => {
    const sigma = await adapter();
    const fixture = generateFixture({ seed: 1 });
    sigma.mount(fixture);
    expect(() => sigma.mount(fixture)).toThrowError(expect.objectContaining({ code: 'ADAPTER_ALREADY_MOUNTED' }));
    sigma.dispose();
    expect(() => sigma.describe()).toThrowError(expect.objectContaining({ code: 'ADAPTER_NOT_MOUNTED' }));
    sigma.mount(fixture);
    expect(sigma.describe().nodes).toHaveLength(fixture.nodes.length);
  });

  it('refuses to focus a node that is not in the graph', async () => {
    const sigma = await adapter();
    sigma.mount(generateFixture({ seed: 1 }));
    expect(() => sigma.setFocus('nope')).toThrowError(expect.objectContaining({ code: 'ADAPTER_NODE_UNKNOWN' }));
  });
});
