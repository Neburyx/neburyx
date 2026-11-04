import { afterEach, describe, expect, it } from 'vitest';
import { stubSizeObserver } from '../test-utils.js';
import { followSize } from './follow-size.js';

let stub: ReturnType<typeof stubSizeObserver> | undefined;
afterEach(() => stub?.restore());

describe('following an element\'s size', () => {
  it('calls back each time the element changes size, and stops once told to', () => {
    stub = stubSizeObserver();
    const element = document.createElement('div');
    let calls = 0;
    const stop = followSize(element, () => (calls += 1));
    stub.resize(element, 500);
    stub.resize(element, 400);
    expect(calls).toBe(2);
    stop();
    stub.resize(element, 300);
    expect(calls).toBe(2);
  });

  it('does not call back for another element', () => {
    stub = stubSizeObserver();
    let calls = 0;
    followSize(document.createElement('div'), () => (calls += 1));
    stub.resize(document.createElement('div'), 500);
    expect(calls).toBe(0);
  });

  it('does nothing and throws nothing where the browser cannot observe sizes', () => {
    const original = globalThis.ResizeObserver;
    // @ts-expect-error the observer is taken away for this case
    delete globalThis.ResizeObserver;
    try {
      const stop = followSize(document.createElement('div'), () => undefined);
      expect(() => stop()).not.toThrow();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});
