import { describe, expect, it } from 'vitest';
import { selectedKeysOf } from './selection.js';

const NODE = (id: string) => JSON.stringify(['node', 'demo', 'widget', id]);
const VIEW = [NODE('A-1'), NODE('A-2'), NODE('A-3')];

describe('the selection a turn may use', () => {
  it('keeps the selected keys that are in the view, in the order of the view and each once', () => {
    expect(selectedKeysOf(VIEW, [NODE('A-3'), NODE('A-1')])).toEqual([NODE('A-1'), NODE('A-3')]);
    expect(selectedKeysOf(VIEW, [NODE('A-2'), NODE('A-2')])).toEqual([NODE('A-2')]);
  });

  it('drops a key that is not in the view, a key of another source and an empty string, and is empty for none', () => {
    expect(selectedKeysOf(VIEW, [NODE('A-9'), JSON.stringify(['node', 'other', 'widget', 'A-1']), '', NODE('A-2')])).toEqual([NODE('A-2')]);
    expect(selectedKeysOf(VIEW, [])).toEqual([]);
    expect(selectedKeysOf(VIEW, undefined)).toEqual([]);
    expect(selectedKeysOf([], [NODE('A-1')])).toEqual([]);
  });
});
