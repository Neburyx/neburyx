export const IDENTIFIER_FONT = '500 12px "IBM Plex Mono"';
export const DETAIL_FONT = '400 12px Inter';

export interface FontSource {
  check(font: string): boolean;
  load(font: string): Promise<unknown>;
}

const CAPTION_FONTS = [IDENTIFIER_FONT, DETAIL_FONT] as const;

/** Whether the caption faces are ready to draw with; a canvas draws in a fallback face for one that has not loaded yet. */
export function captionFontsReady(fonts: FontSource | undefined = document.fonts): boolean {
  return fonts === undefined || CAPTION_FONTS.every((font) => fonts.check(font));
}

export async function loadCaptionFonts(fonts: FontSource | undefined = document.fonts): Promise<void> {
  if (fonts === undefined) return;
  await Promise.all(CAPTION_FONTS.map((font) => fonts.load(font)));
}
