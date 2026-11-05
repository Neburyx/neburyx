import { describe, expect, it } from 'vitest';
import { matchesKeys, parseKeys, sameKeys, showKeys, type KeyEventLike } from './key-spec.js';

const press = (key: string, modifiers: Partial<Omit<KeyEventLike, 'key'>> = {}): KeyEventLike => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers });

describe('the text of keys', () => {
  it('reads a key with its modifiers, and refuses an empty key or an unknown modifier', () => {
    expect(parseKeys('mod+shift+i')).toEqual({ key: 'i', mod: true, shift: true, alt: false });
    expect(parseKeys('Escape')).toEqual({ key: 'escape', mod: false, shift: false, alt: false });
    expect(() => parseKeys('mod+')).toThrow('name no key');
    expect(() => parseKeys('hyper+k')).toThrow('unknown modifier');
  });

  it('shows ⌘ and ⇧ on macOS and Ctrl and Shift elsewhere, with the names of the special keys', () => {
    expect(showKeys(parseKeys('mod+shift+i'), 'mac')).toBe('⇧⌘I');
    expect(showKeys(parseKeys('mod+shift+i'), 'other')).toBe('Ctrl+Shift+I');
    expect(showKeys(parseKeys('mod+0'), 'mac')).toBe('⌘0');
    expect(showKeys(parseKeys('escape'), 'other')).toBe('Esc');
    expect(showKeys(parseKeys('shift+f10'), 'mac')).toBe('⇧F10');
    expect(showKeys(parseKeys('arrowleft'), 'other')).toBe('←');
    expect(showKeys(parseKeys('contextmenu'), 'other')).toBe('Menu');
    expect(showKeys(parseKeys('mod+/'), 'other')).toBe('Ctrl+/');
  });

  it('tells two keys apart by key, modifier and shift', () => {
    expect(sameKeys(parseKeys('mod+c'), parseKeys('mod+c'))).toBe(true);
    expect(sameKeys(parseKeys('mod+c'), parseKeys('mod+shift+c'))).toBe(false);
    expect(sameKeys(parseKeys('p'), parseKeys('shift+p'))).toBe(false);
  });
});

describe('matching a key press', () => {
  it('matches ⌘ on macOS only and Ctrl elsewhere only', () => {
    const spec = parseKeys('mod+0');
    expect(matchesKeys(spec, press('0', { metaKey: true }), 'mac')).toBe(true);
    expect(matchesKeys(spec, press('0', { ctrlKey: true }), 'mac')).toBe(false);
    expect(matchesKeys(spec, press('0', { ctrlKey: true }), 'other')).toBe(true);
    expect(matchesKeys(spec, press('0', { metaKey: true }), 'other')).toBe(false);
    expect(matchesKeys(spec, press('0'), 'other')).toBe(false);
  });

  it('refuses Alt that is not named, and counts Shift for a letter whatever its case', () => {
    expect(matchesKeys(parseKeys('v'), press('v', { altKey: true }), 'other')).toBe(false);
    expect(matchesKeys(parseKeys('p'), press('P', { shiftKey: true }), 'other')).toBe(false);
    expect(matchesKeys(parseKeys('shift+p'), press('P', { shiftKey: true }), 'other')).toBe(true);
    expect(matchesKeys(parseKeys('shift+p'), press('p'), 'other')).toBe(false);
    expect(matchesKeys(parseKeys('mod+shift+c'), press('C', { metaKey: true, shiftKey: true }), 'mac')).toBe(true);
    expect(matchesKeys(parseKeys('mod+c'), press('C', { metaKey: true, shiftKey: true }), 'mac')).toBe(false);
  });

  it('does not count Shift for a symbol some layouts type with it, and counts it for a named key', () => {
    expect(matchesKeys(parseKeys('mod+/'), press('/', { ctrlKey: true, shiftKey: true }), 'other')).toBe(true);
    expect(matchesKeys(parseKeys('mod+/'), press('/', { ctrlKey: true }), 'other')).toBe(true);
    expect(matchesKeys(parseKeys('tab'), press('Tab', { shiftKey: true }), 'other')).toBe(false);
    expect(matchesKeys(parseKeys('shift+tab'), press('Tab', { shiftKey: true }), 'other')).toBe(true);
    expect(matchesKeys(parseKeys('space'), press(' '), 'other')).toBe(true);
  });
});
