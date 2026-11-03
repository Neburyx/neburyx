import { ICON_KEYS, type IconKey } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { glyphUri, GLYPHS } from './glyphs.js';

const EXPECTED: Readonly<Record<IconKey, string>> = {
  generic: 'circle-dot',
  person: 'user',
  organization: 'building-2',
  terminal: 'monitor',
  network: 'globe',
  document: 'file-text',
  money: 'landmark',
  storefront: 'store',
  telephone: 'phone',
  house: 'house',
  car: 'car',
  wrench: 'wrench',
  shield: 'shield',
  folder: 'folder',
};

describe('the glyph of each icon key', () => {
  it('covers exactly the 14 keys of the profile, each with the Lucide glyph the table names', () => {
    expect(Object.keys(GLYPHS).sort()).toEqual([...ICON_KEYS].sort());
    for (const key of ICON_KEYS) expect(GLYPHS[key]).toContain(`lucide-${EXPECTED[key]}"`);
  });

  it('gives no two keys the same glyph', () => {
    expect(new Set(Object.values(GLYPHS)).size).toBe(ICON_KEYS.length);
  });

  it('writes the colour into the image, since an image cannot inherit it', () => {
    const uri = glyphUri('person', '#747a85');
    expect(uri.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    const text = decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length));
    expect(text).toContain('stroke="#747a85"');
    expect(text).not.toContain('currentColor');
  });
});
