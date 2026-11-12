import { describe, expect, it, vi } from 'vitest';
import { AiActionError, createAiActions } from './ai-actions.js';

describe('the handlers of the AI actions', () => {
  it('holds a handler from its registration until the function it returned is called', () => {
    const actions = createAiActions();
    const handler = vi.fn();
    const remove = actions.register('ask', handler);
    expect(actions.view.getState().get('ask')).toBe(handler);
    remove();
    expect(actions.view.getState().has('ask')).toBe(false);
  });

  it('refuses a second handler for an action that has one, and keeps the first', () => {
    const actions = createAiActions();
    const first = vi.fn();
    actions.register('summarize', first);
    expect(() => actions.register('summarize', vi.fn())).toThrow(AiActionError);
    expect(actions.view.getState().get('summarize')).toBe(first);
  });

  it('lets an action be registered again after it was taken out, and never removes a newer handler by an older function', () => {
    const actions = createAiActions();
    const removeOld = actions.register('ask', vi.fn());
    removeOld();
    const next = vi.fn();
    actions.register('ask', next);
    removeOld();
    expect(actions.view.getState().get('ask')).toBe(next);
  });

  it('keeps the two actions apart', () => {
    const actions = createAiActions();
    actions.register('ask', vi.fn());
    expect(actions.view.getState().has('summarize')).toBe(false);
  });
});
