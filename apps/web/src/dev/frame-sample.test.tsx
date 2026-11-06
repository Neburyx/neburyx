import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { fakeClient } from '../api/fake-client.js';
import { RendererProvider } from '../canvas/renderer-context.js';
import { ClientStateProvider } from '../state/context.js';
import { appRoutes } from '../routes.js';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { builtInKeyBindings, stubFactory } from '../test-utils.js';
import { KeyBindingsProvider } from '../workspace/key-binding-registry.js';
import { createFrameSampleState, frameSampleProfile, FRAME_SAMPLE_SOURCE } from './frame-sample.js';
import { sampleProfile, titledSample } from './frame-sample-page.js';

describe('the frame sample with a title from the address', () => {
  it('keeps the investigation record, and takes the title from `?title=` when there is one', () => {
    expect(titledSample('').investigation.getState().record?.title).toBe('Suspicious linked accounts');
    expect(titledSample('?title=').investigation.getState().record?.title).toBe('Suspicious linked accounts');
    const state = titledSample('?title=A%20long%20title');
    expect(state.investigation.getState().record).toMatchObject({ title: 'A long title', caseRef: 'REF-2026-1048' });
  });
});

describe('the frame sample', () => {
  it('pins one entity, so that a drag of a pinned entity can be tried on it', () => {
    const state = createFrameSampleState();
    expect([...state.presentation.view.getState().pins]).toEqual([elementKey({ sourceId: FRAME_SAMPLE_SOURCE, entityType: 'gadget', stableId: 'gad-2' })]);
  });


  it('holds the ten entities and thirteen relationships of the design, each entity placed, one relationship an aggregate of 42 and one derived', () => {
    const state = createFrameSampleState();
    const graph = state.loadedGraph();
    expect(graph.nodes).toHaveLength(10);
    expect(graph.edges).toHaveLength(13);
    expect(state.presentation.view.getState().positions.size).toBe(10);
    expect(graph.edges.filter((edge) => 'aggregate' in edge.ref).map((edge) => edge.memberCount)).toEqual([{ value: 42, quality: 'exact', scope: expect.any(String) }]);
    expect(graph.edges.filter((edge) => edge.semantics === 'derived')).toHaveLength(1);
    expect(state.investigation.getState().sourceId).toBe(FRAME_SAMPLE_SOURCE);
  });

  it('places the entities where the design draws the centre of each disc, and its profile lists every type used', () => {
    const state = createFrameSampleState();
    const types = new Set(frameSampleProfile().entityTypes.map((entry) => entry.type));
    for (const node of state.loadedGraph().nodes) expect(types.has(node.ref.entityType)).toBe(true);
    const first = state.loadedGraph().nodes[0];
    expect(first === undefined ? undefined : state.presentation.view.getState().positions.get(elementKey(first.ref))).toEqual({ x: 180, y: 430 });
  });

  it('opens at /dev/frame-sample as the whole workspace drawing it, with the profile\'s names', async () => {
    const factory = stubFactory();
    const state = createClientState();
    const router = createMemoryRouter(appRoutes(fakeClient(), state), { initialEntries: ['/dev/frame-sample'] });
    render(
      <ClientStateProvider state={state}>
        <KeyBindingsProvider registry={builtInKeyBindings()}>
          <RendererProvider createRenderer={factory.create}>
            <RouterProvider router={router} />
          </RendererProvider>
        </KeyBindingsProvider>
      </ClientStateProvider>,
    );
    await screen.findByRole('application', { name: 'Graph canvas' });
    await waitFor(() => {
      const scene = factory.made.at(-1)?.scenes.at(-1);
      expect(scene?.entities.find((entity) => entity.look.line1 === 'LED-48291')?.look).toEqual({ iconKey: 'money', line1: 'LED-48291', line2: 'Ledger · Review required' });
    });
  });

  it('adds neutral types with names of their own when the address says ?legendTypes, and a long unbroken name when it says ?legendLabel=long', () => {
    const types = sampleProfile('?legendTypes=12&legendLabel=long').entityTypes;
    expect(types).toHaveLength(12);
    expect(types[0]?.displayName).toBe('W'.repeat(60));
    const added = types.slice(frameSampleProfile().entityTypes.length);
    expect(added.map((type) => type.displayName)).toEqual(added.map((_type, index) => `Kind ${index}`));
    expect(new Set(types.map((type) => type.displayName)).size).toBe(12);
  });

  it('leaves the sample\'s own profile alone when the address asks for nothing', () => {
    expect(sampleProfile('')).toEqual(frameSampleProfile());
  });
});
