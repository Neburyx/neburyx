import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { stubSizeObserver } from '../test-utils.js';
import { GraphScopeLines } from './graph-scope.js';
import { UNKNOWN_REMAINDER } from './scope-text.js';
import type { LoadedGraph } from '../state/loaded-graph.js';

const EMPTY: LoadedGraph = { nodes: [], edges: [], entities: { value: 0, quality: 'exact', scope: 'loaded in this view' }, relationships: { value: 0, quality: 'exact', scope: 'loaded in this view' } };

let stub: ReturnType<typeof stubSizeObserver> | undefined;
afterEach(() => stub?.restore());

function shown() {
  stub = stubSizeObserver();
  const view = render(
    <div data-testid="region">
      <GraphScopeLines graph={EMPTY} hidden={new Set()} filtered={new Set()} notRetrieved={UNKNOWN_REMAINDER} />
    </div>,
  );
  const region = view.getByTestId('region');
  const scope = view.getByRole('group', { name: 'Graph scope' });
  return { region, scope, view };
}

describe('the bottom of the scope lines, given to the canvas region', () => {
  it('is the distance from the top of the region to the bottom of the scope lines, and follows them as they grow', () => {
    const { region, scope } = shown();
    act(() => stub?.resize(scope, 300, 44));
    expect(region.style.getPropertyValue('--scope-bottom')).toBe('44px');
    act(() => stub?.resize(scope, 300, 64));
    expect(region.style.getPropertyValue('--scope-bottom')).toBe('64px');
  });

  it('is taken away with the scope lines', () => {
    const { region, view } = shown();
    view.unmount();
    expect(region.style.getPropertyValue('--scope-bottom')).toBe('');
  });
});
