import { describe, expect, it } from 'vitest';
import { attachKeyboard, type KeyboardActions } from './keyboard.js';

function key(name: string): Event {
  return Object.assign(new Event('keydown', { cancelable: true }), { key: name });
}

function recorder(): { readonly actions: KeyboardActions; readonly calls: string[] } {
  const calls: string[] = [];
  const note = (name: string) => () => {
    calls.push(name);
  };
  return { calls, actions: { beforeKey: note('beforeKey'), enter: note('enter'), leave: note('leave'), next: note('next'), previous: note('previous'), first: note('first'), last: note('last'), activate: note('activate') } };
}

describe('attachKeyboard', () => {
  it('maps the keys to actions, prevents their default, and ignores other keys', () => {
    const host = new EventTarget();
    const document = new EventTarget();
    const { actions, calls } = recorder();
    attachKeyboard(host, document, actions, new AbortController().signal);
    const arrow = key('ArrowRight');
    host.dispatchEvent(arrow);
    host.dispatchEvent(key('End'));
    host.dispatchEvent(key('Enter'));
    host.dispatchEvent(key('x'));
    expect(calls).toEqual(['next', 'last', 'activate']);
    expect(arrow.defaultPrevented).toBe(true);
  });

  it('reports focus and blur and resets before every key anywhere in the document', () => {
    const host = new EventTarget();
    const document = new EventTarget();
    const { actions, calls } = recorder();
    attachKeyboard(host, document, actions, new AbortController().signal);
    host.dispatchEvent(new Event('focus'));
    document.dispatchEvent(key('a'));
    host.dispatchEvent(new Event('blur'));
    expect(calls).toEqual(['enter', 'beforeKey', 'leave']);
  });

  it('removes every listener when the signal aborts, so later keys and focus do nothing', () => {
    const host = new EventTarget();
    const document = new EventTarget();
    const { actions, calls } = recorder();
    const controller = new AbortController();
    attachKeyboard(host, document, actions, controller.signal);
    controller.abort();
    host.dispatchEvent(key('ArrowRight'));
    host.dispatchEvent(new Event('focus'));
    document.dispatchEvent(key('a'));
    expect(calls).toEqual([]);
  });
});
