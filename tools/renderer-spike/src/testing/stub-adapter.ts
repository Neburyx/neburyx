import type { Position, RendererAdapter, ViewState } from '../adapter.js';
import type { Additions } from '../fixture/schema.js';

export interface StubOptions {
  readonly positions?: ReadonlyMap<string, Position>;
  readonly onAddNodes?: (positions: Map<string, Position>, additions: Additions, fixed: ReadonlySet<string>) => void;
  readonly views?: ViewState[];
}

export function stubAdapter(options: StubOptions = {}): RendererAdapter {
  const positions = new Map<string, Position>(options.positions ?? []);
  const fixed = new Set<string>();
  return {
    name: 'stub',
    notes: [],
    holdMechanism: 'stub lock',
    mount: () => undefined,
    describe: () => ({ nodes: [...positions.keys()].map((id) => ({ id, kind: 'entity', label: id, iconKey: 'circle', iconDrawn: true, color: '', dashedBorder: false })), relationships: [] }),
    applyView: (view) => {
      options.views?.push(view);
    },
    getPositions: () => new Map(positions),
    setPositions: (updates) => {
      for (const [id, position] of updates) positions.set(id, position);
    },
    fix: (ids) => {
      for (const id of ids) fixed.add(id);
    },
    addNodes: (additions) => {
      for (const node of additions.nodes) positions.set(node.id, { x: 0, y: 0 });
      options.onAddNodes?.(positions, additions, fixed);
    },
    groupByType: () => undefined,
    ungroupByType: () => undefined,
    groups: () => [],
    setFocus: () => undefined,
    isFocusRingVisible: () => false,
    dispose: () => undefined,
  };
}
