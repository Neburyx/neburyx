export type Platform = 'mac' | 'other';

export interface KeySpec {
  readonly key: string;
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

export interface KeyEventLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

const NAMES: Readonly<Record<string, string>> = {
  escape: 'Esc',
  enter: 'Enter',
  space: 'Space',
  tab: 'Tab',
  delete: 'Del',
  contextmenu: 'Menu',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
};

const nameOf = (key: string): string => NAMES[key] ?? key.toUpperCase();

/** `mod` is ⌘ on macOS and Ctrl elsewhere: `mod+shift+i`, `shift+f10`, `escape`, `mod+/`. */
export function parseKeys(text: string): KeySpec {
  const tokens = text.toLowerCase().split('+');
  const key = tokens.pop() ?? '';
  if (key === '') throw new Error(`the keys "${text}" name no key`);
  const unknown = tokens.filter((token) => token !== 'mod' && token !== 'shift' && token !== 'alt');
  if (unknown.length > 0) throw new Error(`the keys "${text}" name an unknown modifier`);
  return { key, mod: tokens.includes('mod'), shift: tokens.includes('shift'), alt: tokens.includes('alt') };
}

export function sameKeys(a: KeySpec, b: KeySpec): boolean {
  return a.key === b.key && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt;
}

/** What a person sees for the keys: ⇧⌘I on macOS, Ctrl+Shift+I elsewhere. */
export function showKeys(spec: KeySpec, platform: Platform): string {
  const name = nameOf(spec.key);
  if (platform === 'mac') return `${spec.alt ? '⌥' : ''}${spec.shift ? '⇧' : ''}${spec.mod ? '⌘' : ''}${name}`;
  return [...(spec.mod ? ['Ctrl'] : []), ...(spec.alt ? ['Alt'] : []), ...(spec.shift ? ['Shift'] : []), name].join('+');
}

const isLetter = (key: string): boolean => /^[a-z]$/.test(key);
const isSymbol = (key: string): boolean => key.length === 1 && !isLetter(key);

const keyOf = (event: KeyEventLike): string => (event.key === ' ' ? 'space' : event.key.toLowerCase());

export function matchesKeys(spec: KeySpec, event: KeyEventLike, platform: Platform): boolean {
  if (keyOf(event) !== spec.key) return false;
  const mod = platform === 'mac' ? event.metaKey : event.ctrlKey;
  const otherMod = platform === 'mac' ? event.ctrlKey : event.metaKey;
  if (otherMod || mod !== spec.mod || event.altKey !== spec.alt) return false;
  return isSymbol(spec.key) || event.shiftKey === spec.shift;
}

export function detectPlatform(): Platform {
  return /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? 'mac' : 'other';
}
