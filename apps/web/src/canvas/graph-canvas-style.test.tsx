import { act, cleanup, render } from '@testing-library/react';
import type { GraphNode, SourceProfile } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { entityOf, keyOf, loadedState, profileWith } from '../groups/group-kit.js';
import { ClientStateProvider } from '../state/context.js';
import type { ClientState } from '../state/client-state.js';
import { stubFactory } from '../test-utils.js';
import { GraphCanvas } from './graph-canvas.js';
import { RendererProvider } from './renderer-context.js';

afterEach(cleanup);

const withRules = (node: GraphNode, ids?: string[]): GraphNode => ({ ...node, display: { ...node.display, ...(ids === undefined ? {} : { styleRules: ids }) } });

function profileOf(): SourceProfile {
  return { ...profileWith({ 'kind-a': {} }), styleRules: [{ id: 'review', label: 'Review', appliesTo: 'kind-a', effect: { badge: 'amber' }, condition: 'status = review' }] };
}

function draw(state: ClientState, profile: SourceProfile | undefined) {
  const factory = stubFactory();
  const view = (shown: SourceProfile | undefined) => (
    <ClientStateProvider state={state}>
      <RendererProvider createRenderer={factory.create}>
        <GraphCanvas profile={shown} />
      </RendererProvider>
    </ClientStateProvider>
  );
  const { rerender } = render(view(profile));
  const [renderer] = factory.made;
  if (renderer === undefined) throw new Error('no renderer');
  return { last: () => renderer.scenes.at(-1), show: (shown: SourceProfile | undefined) => rerender(view(shown)) };
}

describe('the canvas with style rules', () => {
  it('draws the look of a node from the rule ids it carries and the profile lists, and the plain look when the profile has not answered or fails', () => {
    const matching = withRules(entityOf('kind-a', 'A1'), ['review']);
    const state = loadedState([matching, entityOf('kind-a', 'A2')]);
    const { last, show } = draw(state, profileOf());
    const lookOf = (id: string) => last()?.entities.find((entity) => entity.id === id)?.look;
    expect(lookOf(keyOf(matching))?.style).toEqual({ badge: 'amber', labels: ['Review'] });
    expect(lookOf(keyOf(entityOf('kind-a', 'A2')))?.style).toBeUndefined();
    act(() => show(undefined));
    expect(lookOf(keyOf(matching))?.style).toBeUndefined();
    act(() => show({ ...profileOf(), styleRules: undefined }));
    expect(lookOf(keyOf(matching))?.style).toBeUndefined();
  });

  it('shows the plain look of a node that carries no rule id, whatever rules the profile lists', () => {
    const plain = entityOf('kind-a', 'A1');
    const state = loadedState([plain]);
    const { last } = draw(state, profileOf());
    expect(last()?.entities[0]?.look.style).toBeUndefined();
  });
});
