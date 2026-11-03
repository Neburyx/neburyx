import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createClientState } from './client-state.js';
import { elementKey } from './keys.js';
import { useStoreSelector } from './store.js';
import { key, ref, result } from './test-data.js';

describe('a component that reads one partition', () => {
  it('does not render again when another partition changes, and does when its own changes', () => {
    const state = createClientState();
    state.bindSource('source-a');
    state.putResult(key('source-a'), result('source-a', ['n1', 'n2']));
    state.setLoaded([key('source-a')], [ref('source-a', 'type-a', 'n1'), ref('source-a', 'type-a', 'n2')], []);
    let renders = 0;
    function Selection() {
      const selection = useStoreSelector(state.presentation.view, (current) => current.selection);
      renders += 1;
      return <p>{selection.size} selected</p>;
    }
    render(<Selection />);
    const initial = renders;
    act(() => state.putResult(key('source-a', 'another'), result('source-a', ['n3'])));
    act(() => state.setLoaded([key('source-a')], [ref('source-a', 'type-a', 'n1')], []));
    expect(renders).toBe(initial);
    act(() => state.presentation.select([elementKey(ref('source-a', 'type-a', 'n1'))]));
    expect(renders).toBe(initial + 1);
    expect(screen.getByText('1 selected')).toBeTruthy();
  });
});
