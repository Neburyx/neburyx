import { CAPTION_HEIGHT, CAPTION_WIDTH, captionBox, HALO_RADIUS, HALO_TOP, KNOCKOUT_PADDING, LINE_GAP, LINE_HEIGHT } from './caption-layout.js';
import { DETAIL_FONT, IDENTIFIER_FONT } from './fonts.js';
import { CAPTION_COLOR, CAPTION_HALO, CAPTION_KNOCKOUT } from './look.js';

const PIXEL_DENSITY = 2;
const HALF = 2;
// The canvas's middle baseline sits a pixel above the centre of the design's 17 px line box for the monospace face and level with it for Inter; measured against frame 74.
const IDENTIFIER_NUDGE = 1;

export type CaptionPainter = (line1: string, line2: string) => string;

/** Draws the two-line caption of an entity on a canvas that is not on the page, line 1 in IBM Plex Mono and line 2 in Inter, and returns it as an image address. */
export const paintCaption: CaptionPainter = (line1, line2) => {
  const canvas = document.createElement('canvas');
  canvas.width = CAPTION_WIDTH * PIXEL_DENSITY;
  canvas.height = CAPTION_HEIGHT * PIXEL_DENSITY;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('a canvas cannot be drawn on here');
  context.scale(PIXEL_DENSITY, PIXEL_DENSITY);
  context.textBaseline = 'middle';
  const measureWith = (font: string) => (text: string): number => {
    context.font = font;
    return context.measureText(text).width;
  };
  const box = captionBox(measureWith(IDENTIFIER_FONT), measureWith(DETAIL_FONT), line1, line2);
  const centre = (width: number): number => (CAPTION_WIDTH - width) / HALF;
  context.fillStyle = CAPTION_HALO;
  context.beginPath();
  context.roundRect(centre(box.halo), 0, box.halo, CAPTION_HEIGHT, HALO_RADIUS);
  context.fill();
  context.fillStyle = CAPTION_KNOCKOUT;
  context.fillRect(centre(box.knockout1), HALO_TOP, box.knockout1, LINE_HEIGHT);
  context.fillRect(centre(box.knockout2), HALO_TOP + LINE_HEIGHT + LINE_GAP, box.knockout2, LINE_HEIGHT);
  context.fillStyle = CAPTION_COLOR;
  context.font = IDENTIFIER_FONT;
  context.fillText(box.line1, centre(box.knockout1) + KNOCKOUT_PADDING, HALO_TOP + LINE_HEIGHT / HALF + IDENTIFIER_NUDGE);
  context.font = DETAIL_FONT;
  context.fillText(box.line2, centre(box.knockout2) + KNOCKOUT_PADDING, HALO_TOP + LINE_HEIGHT + LINE_GAP + LINE_HEIGHT / HALF);
  return canvas.toDataURL('image/png');
};
