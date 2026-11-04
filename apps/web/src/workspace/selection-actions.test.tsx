import { describe, expect, it } from 'vitest';
import { ActionError, createSelectionActionRegistry, type SelectionAction } from './selection-actions.js';

const action = (id: string): SelectionAction => ({ id, label: id, icon: null, run: () => undefined });

describe('the selection action registry', () => {
  it('lists the actions in registration order and takes one out with the function register returned', () => {
    const registry = createSelectionActionRegistry();
    const first = action('expand');
    const remove = registry.register(first);
    registry.register(action('hide'));
    expect(registry.view.getState().map((item) => item.id)).toEqual(['expand', 'hide']);
    remove();
    expect(registry.view.getState().map((item) => item.id)).toEqual(['hide']);
  });

  it('refuses an ID that is already registered with ACTION_TAKEN, and keeps the first', () => {
    const registry = createSelectionActionRegistry();
    registry.register(action('expand'));
    expect(() => registry.register(action('expand'))).toThrow(expect.objectContaining({ code: 'ACTION_TAKEN', actionId: 'expand' }));
    expect(() => registry.register(action('expand'))).toThrow(ActionError);
    expect(registry.view.getState()).toHaveLength(1);
  });

  it('lets an ID be registered again after it was taken out, and a stale remove does not take out the new registration', () => {
    const registry = createSelectionActionRegistry();
    const remove = registry.register(action('pin'));
    remove();
    registry.register(action('pin'));
    remove();
    expect(registry.view.getState().map((item) => item.id)).toEqual(['pin']);
  });

  it('takes out only its own registration when the same action object is registered again after being removed', () => {
    const registry = createSelectionActionRegistry();
    const pin = action('pin');
    const removeFirst = registry.register(pin);
    removeFirst();
    registry.register(pin);
    removeFirst();
    expect(registry.view.getState()).toEqual([pin]);
  });
});
