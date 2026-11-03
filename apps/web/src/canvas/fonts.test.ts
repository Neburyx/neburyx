import { describe, expect, it } from 'vitest';
import { captionFontsReady, DETAIL_FONT, IDENTIFIER_FONT, loadCaptionFonts, type FontSource } from './fonts.js';

function faces(loaded: readonly string[]): { readonly set: FontSource; readonly asked: string[] } {
  const asked: string[] = [];
  const set: FontSource = {
    check: (font) => loaded.includes(font),
    load: async (font) => {
      asked.push(font);
      return [];
    },
  };
  return { set, asked };
}

describe('the caption fonts', () => {
  it('are ready when there is no font set to ask, or both faces are loaded, and not when one is missing', () => {
    expect(captionFontsReady(undefined)).toBe(true);
    expect(captionFontsReady(faces([IDENTIFIER_FONT, DETAIL_FONT]).set)).toBe(true);
    expect(captionFontsReady(faces([IDENTIFIER_FONT]).set)).toBe(false);
    expect(captionFontsReady(faces([]).set)).toBe(false);
  });

  it('are asked for both faces, and nothing is asked when there is no font set', async () => {
    const { set, asked } = faces([]);
    await loadCaptionFonts(set);
    expect(asked.sort()).toEqual([DETAIL_FONT, IDENTIFIER_FONT].sort());
    await expect(loadCaptionFonts(undefined)).resolves.toBeUndefined();
  });
});
