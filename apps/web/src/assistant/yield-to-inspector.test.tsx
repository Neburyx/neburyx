import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { INSPECTOR_PANEL_ID } from '../inspector/inspector-layout.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { createPanelRegistryFor, PanelsProvider } from '../workspace/panel-registry.js';
import { ASSISTANT_PANEL_ID, ASSISTANT_PANEL_WIDE_SIZE } from './panel-layout.js';
import { useNarrowWhenInspectorOpens } from './yield-to-inspector.js';

afterEach(cleanup);

function Probe({ yielding }: { readonly yielding: boolean }) {
  return <p data-testid="note">{useNarrowWhenInspectorOpens(yielding) ?? ''}</p>;
}

describe('the Assistant that comes back from the pop-out note with the inspector open', () => {
  it('is left alone while it is collapsed, and returns to its normal width, saying so, when it comes into view', () => {
    const state = createClientState();
    const registry = createPanelRegistryFor(state);
    act(() => void registry.register({ id: INSPECTOR_PANEL_ID, title: 'Inspector', placement: { kind: 'floating', side: 'right', top: 16 }, content: () => null }));
    act(() => state.presentation.setPanelSize(ASSISTANT_PANEL_ID, ASSISTANT_PANEL_WIDE_SIZE));
    const tree = (yielding: boolean) => (
      <ClientStateProvider state={state}>
        <PanelsProvider registry={registry}>
          <Probe yielding={yielding} />
        </PanelsProvider>
      </ClientStateProvider>
    );
    const { rerender } = render(tree(false));
    expect(state.presentation.view.getState().panelSizes.get(ASSISTANT_PANEL_ID)).toBe(ASSISTANT_PANEL_WIDE_SIZE);
    expect(screen.getByTestId('note').textContent).toBe('');
    rerender(tree(true));
    expect(state.presentation.view.getState().panelSizes.get(ASSISTANT_PANEL_ID)).toBeUndefined();
    expect(screen.getByTestId('note').textContent).toMatch(/back to its normal width because the inspector is open/i);
  });
});
