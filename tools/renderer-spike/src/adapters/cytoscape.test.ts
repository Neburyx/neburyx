import { describe, expect, it } from 'vitest';
import { AdapterError } from '../adapter.js';
import { FixtureError } from '../fixture/errors.js';
import { generateFixture } from '../fixture/generate.js';
import { createCytoscapeAdapter } from './cytoscape.js';

function mounted() {
  const adapter = createCytoscapeAdapter({ container: undefined });
  adapter.mount(generateFixture({ seed: 1 }));
  return adapter;
}

describe('the Cytoscape.js adapter, headless', () => {
  it('draws 300 elements', () => {
    const drawing = mounted().describe();
    expect(drawing.nodes.length + drawing.relationships.length).toBe(300);
  });

  it('draws every node with its type icon and a two-line label for entities', () => {
    const drawing = mounted().describe();
    const entities = drawing.nodes.filter((node) => node.kind === 'entity');
    expect(entities.length).toBeGreaterThan(0);
    for (const node of entities) {
      expect(node.iconDrawn).toBe(true);
      expect(node.label).toMatch(/^[A-D]-\d{4}\nType [A-D] · (open|review|closed)$/);
    }
  });

  it('draws sourced relationships solid and derived ones dashed, all with an arrow', () => {
    const drawing = mounted().describe();
    const sourced = drawing.relationships.filter((relationship) => relationship.kind === 'sourced');
    const derived = drawing.relationships.filter((relationship) => relationship.kind === 'derived');
    expect(sourced.length).toBeGreaterThan(0);
    expect(derived.length).toBeGreaterThan(0);
    expect(sourced.every((relationship) => relationship.lineStyle === 'solid' && relationship.hasArrow)).toBe(true);
    expect(derived.every((relationship) => relationship.lineStyle === 'dashed' && relationship.hasArrow)).toBe(true);
  });

  it('draws the aggregate relationship thicker, labelled with its type and count in an outlined pill', () => {
    const drawing = mounted().describe();
    const aggregate = drawing.relationships.filter((relationship) => relationship.kind === 'aggregate');
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0]).toMatchObject({ lineStyle: 'solid', labelOutlined: true });
    expect(aggregate[0]?.label).toMatch(/^rel-b · \d+$/);
    const plain = drawing.relationships.find((relationship) => relationship.kind === 'sourced');
    expect(aggregate[0]?.width).toBeGreaterThan(plain?.width ?? Infinity);
  });

  it('draws the neighbor aggregate node as a dashed chip labelled loaded over a lower bound', () => {
    const chips = mounted().describe().nodes.filter((node) => node.kind === 'neighborAggregate');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.dashedBorder).toBe(true);
    expect(chips[0]?.label).toMatch(/^Type [A-D] · \d+ \/ ≥ 3,000$/);
  });

  it('can be mounted again after it is disposed, and draws the same thing', () => {
    const adapter = createCytoscapeAdapter({ container: undefined });
    const fixture = generateFixture({ seed: 1 });
    adapter.mount(fixture);
    const first = adapter.describe();
    adapter.dispose();
    adapter.mount(fixture);
    expect(adapter.describe()).toEqual(first);
  });

  it('refuses a second mount before dispose and a describe before mount', () => {
    const adapter = createCytoscapeAdapter({ container: undefined });
    expect(() => adapter.describe()).toThrowError(expect.objectContaining({ code: 'ADAPTER_NOT_MOUNTED' }));
    adapter.mount(generateFixture({ seed: 1 }));
    expect(() => adapter.mount(generateFixture({ seed: 1 }))).toThrowError(AdapterError);
  });

  it('refuses a fixture that fails its schema with the named error and draws nothing', () => {
    const adapter = createCytoscapeAdapter({ container: undefined });
    const broken = { ...generateFixture({ seed: 1 }), nodes: [] };
    expect(() => adapter.mount(broken)).toThrowError(expect.objectContaining({ code: 'FIXTURE_INVALID' }));
    expect(() => adapter.mount(broken)).toThrowError(FixtureError);
    expect(() => adapter.describe()).toThrowError(expect.objectContaining({ code: 'ADAPTER_NOT_MOUNTED' }));
  });
});

describe('the Cytoscape.js adapter, grouping and focus', () => {
  const fixture = generateFixture({ seed: 1 });
  const typeBMembers = fixture.nodes.filter((node) => node.kind === 'entity' && node.type === 'type-b').length;

  it('puts every node of a type in one compound group and takes them out again, with the same node count', () => {
    const adapter = mounted();
    const before = adapter.describe().nodes.length;
    adapter.groupByType('type-b');
    expect(adapter.groups()).toEqual([{ typeId: 'type-b', members: typeBMembers }]);
    expect(adapter.describe().nodes).toHaveLength(before);
    adapter.ungroupByType('type-b');
    expect(adapter.groups()).toEqual([]);
    expect(adapter.describe().nodes).toHaveLength(before);
  });

  it('refuses to group a type with no nodes, with a named error, and leaves the picture as it was', () => {
    const adapter = mounted();
    const before = adapter.describe();
    expect(() => adapter.groupByType('type-z')).toThrowError(expect.objectContaining({ code: 'ADAPTER_GROUP_EMPTY' }));
    expect(adapter.groups()).toEqual([]);
    expect(adapter.describe()).toEqual(before);
  });

  it('draws a focus ring on one node at a time and removes it', () => {
    const adapter = mounted();
    const [first, second] = adapter.describe().nodes;
    adapter.setFocus(first?.id);
    expect(first && adapter.isFocusRingVisible(first.id)).toBe(true);
    adapter.setFocus(second?.id);
    expect(first && adapter.isFocusRingVisible(first.id)).toBe(false);
    expect(second && adapter.isFocusRingVisible(second.id)).toBe(true);
    adapter.setFocus(undefined);
    expect(second && adapter.isFocusRingVisible(second.id)).toBe(false);
  });

  it('refuses to focus a node that is not drawn', () => {
    expect(() => mounted().setFocus('nope')).toThrowError(expect.objectContaining({ code: 'ADAPTER_NODE_UNKNOWN' }));
  });
});
