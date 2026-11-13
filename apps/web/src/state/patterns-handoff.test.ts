import { describe, expect, it } from 'vitest';
import { createClientState } from './client-state.js';

describe('the preset Home hands to the Patterns panel', () => {
  it('is held until read and cleared', () => {
    const state = createClientState();
    state.bindSource('a');
    state.presentation.setPatternsPreset('shared-devices');
    expect(state.presentation.view.getState().patternsPreset).toBe('shared-devices');
    state.presentation.setPatternsPreset(undefined);
    expect(state.presentation.view.getState().patternsPreset).toBeUndefined();
  });

  it('is set after a source bind and survives the reset that bind does only when set after it', () => {
    const state = createClientState();
    state.presentation.setPatternsPreset('shared-devices');
    state.bindSource('a');
    expect(state.presentation.view.getState().patternsPreset).toBeUndefined();
    state.presentation.setPatternsPreset('shared-devices');
    state.presentation.setPatternsOpen(true);
    expect(state.presentation.view.getState().patternsPreset).toBe('shared-devices');
    expect(state.presentation.view.getState().patternsOpen).toBe(true);
  });

  it('is forgotten when the panel is closed', () => {
    const state = createClientState();
    state.presentation.setPatternsOpen(true);
    state.presentation.setPatternsPreset('connected-accounts');
    state.presentation.setPatternsOpen(false);
    expect(state.presentation.view.getState().patternsPreset).toBeUndefined();
  });
});

describe('returning to no source bound', () => {
  it('lets the source go, closes the panel and resets the presentation when nothing is shown or loaded', () => {
    const state = createClientState();
    state.bindSource('a');
    state.presentation.setPatternsOpen(true);
    state.unbindSource();
    expect(state.investigation.getState()).toMatchObject({ id: null, sourceId: null, nodeRefs: [], edgeRefs: [] });
    expect(state.presentation.view.getState().patternsOpen).toBe(false);
  });

  it('does nothing when no source is bound', () => {
    const state = createClientState();
    state.unbindSource();
    expect(state.investigation.getState().sourceId).toBeNull();
  });

  it('does nothing while an entity is loaded', () => {
    const state = createClientState();
    state.bindSource('a');
    state.setLoaded([], [{ sourceId: 'a', entityType: 'kind-a', stableId: 'A-1' }], []);
    state.unbindSource();
    expect(state.investigation.getState().sourceId).toBe('a');
    expect(state.investigation.getState().nodeRefs).toHaveLength(1);
  });
});
