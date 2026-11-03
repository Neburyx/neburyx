import { describe, expect, it } from 'vitest';
import { summarizeGrouping, summarizeKeyboard, type KeyboardState } from './probes.js';

const snapshot = (nodesDrawn: number, groups: { typeId: string; members: number }[] = []) => ({ supported: true, nodesDrawn, groups });

describe('summarizeGrouping', () => {
  it('reports the member count and that the picture was restored', () => {
    const result = summarizeGrouping('type-b', snapshot(120), snapshot(120, [{ typeId: 'type-b', members: 30 }]), snapshot(120));
    expect(result).toMatchObject({ supported: true, members: 30, restored: true });
  });

  it('reports not restored when a group or a node is left over', () => {
    expect(summarizeGrouping('type-b', snapshot(120), snapshot(121), snapshot(121)).restored).toBe(false);
    expect(summarizeGrouping('type-b', snapshot(120), snapshot(120), snapshot(120, [{ typeId: 'type-b', members: 1 }])).restored).toBe(false);
  });
});

describe('summarizeKeyboard', () => {
  const keys = ['Tab', 'End', 'ArrowRight', 'Home', 'Tab', 'ArrowRight'];
  const on = (focusedId: string): KeyboardState => ({ focusedId, ringVisible: true, activatedId: null, canvasFocused: true, announced: focusedId });
  const off: KeyboardState = { focusedId: null, ringVisible: false, activatedId: null, canvasFocused: false, announced: '' };

  it('finds that focus wraps from the last node to the first and that keys do nothing outside the canvas', () => {
    const result = summarizeKeyboard(keys, [on('a'), on('z'), on('a'), on('a'), off, off]);
    expect(result.wrapsFromLast).toBe(true);
    expect(result.ignoredWithoutFocus).toBe(true);
  });

  it('finds that focus does not wrap, and that a key still acts outside the canvas', () => {
    const result = summarizeKeyboard(keys, [on('a'), on('z'), on('z'), on('a'), off, { ...off, activatedId: 'a' }]);
    expect(result.wrapsFromLast).toBe(false);
    expect(result.ignoredWithoutFocus).toBe(false);
  });
});
