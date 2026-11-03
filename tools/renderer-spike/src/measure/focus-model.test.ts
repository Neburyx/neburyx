import { describe, expect, it } from 'vitest';
import { createFocusModel } from './focus-model.js';

describe('createFocusModel', () => {
  it('starts with no focus, enters at the first node and moves in order', () => {
    const model = createFocusModel(['a', 'b', 'c']);
    expect(model.current()).toBeUndefined();
    expect(model.enter()).toBe('a');
    expect(model.next()).toBe('b');
    expect(model.next()).toBe('c');
  });

  it('wraps to the first node after the last and to the last before the first', () => {
    const model = createFocusModel(['a', 'b', 'c']);
    expect(model.last()).toBe('c');
    expect(model.next()).toBe('a');
    expect(model.previous()).toBe('c');
  });

  it('keeps its place when entered again', () => {
    const model = createFocusModel(['a', 'b', 'c']);
    model.next();
    model.next();
    expect(model.enter()).toBe('b');
  });

  it('activates the focused node and nothing before focus', () => {
    const model = createFocusModel(['a', 'b']);
    expect(model.activate()).toBeUndefined();
    model.next();
    expect(model.activate()).toBe('a');
  });

  it('refuses an empty order', () => {
    expect(() => createFocusModel([])).toThrowError(expect.objectContaining({ code: 'FOCUS_ORDER_EMPTY' }));
  });
});
