import { CAPTION_KNOCKOUT } from '../canvas/look.js';
import type { SnapshotBounds } from '../canvas/snapshot.js';

/** The longest side of the file. Far under what browsers accept (32,767 px in Chrome); a drawing of 300 entities never needs more. */
export const MAX_PICTURE_EDGE = 8192;
/** Browsers refuse a canvas of more pixels than this (16,777,216, the lowest limit among them), and a picture of that many pixels is a few megabytes. */
export const MAX_PICTURE_AREA = 16_777_216;

const MARGIN = 32;
const BAND_PADDING = 24;
const LINE_HEIGHT = 22;
const MIN_WIDTH = 720;
const HEADER_FONT = '14px "IBM Plex Mono", ui-monospace, monospace';
const HEADER_COLOR = '#4a5261';
const RULE_COLOR = '#cad0da';
// the header of an export has five lines, or six with the note of what the person may not see
const MAX_HEADER_LINES = 6;

export const bandHeightOf = (lines: number): number => lines * LINE_HEIGHT + 2 * BAND_PADDING;

/** What the drawing may take so that the whole file, header band and margins included, stays within both bounds. */
export function drawingBoundsFor(): SnapshotBounds {
  const band = bandHeightOf(MAX_HEADER_LINES);
  return {
    maxWidth: MAX_PICTURE_EDGE - 2 * MARGIN,
    maxHeight: MAX_PICTURE_EDGE - band - 2 * MARGIN,
    maxArea: MAX_PICTURE_AREA - band * MAX_PICTURE_EDGE - 4 * MARGIN * MAX_PICTURE_EDGE - 4 * MARGIN * MARGIN,
  };
}

interface DrawingBitmap {
  readonly width: number;
  readonly height: number;
  readonly source: CanvasImageSource;
}

/** The part of a 2D canvas the file is drawn with, so a test can record the drawing. */
export interface PictureContext {
  font: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  textBaseline: CanvasTextBaseline;
  measureText(text: string): { readonly width: number };
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  drawImage(image: CanvasImageSource, x: number, y: number): void;
}

interface PictureSurface {
  readonly context: PictureContext;
  resize(width: number, height: number): void;
  toBlob(): Promise<Blob>;
}

export interface PictureDeps {
  readonly surface: () => PictureSurface;
  readonly bitmap: (drawing: Blob) => Promise<DrawingBitmap>;
}

function browserSurface(): PictureSurface {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('a canvas cannot be drawn on here');
  return {
    context,
    resize(width, height) {
      canvas.width = width;
      canvas.height = height;
    },
    toBlob: () => new Promise((resolve, reject) => canvas.toBlob((blob) => (blob === null ? reject(new Error('the picture could not be encoded')) : resolve(blob)), 'image/png')),
  };
}

const browserDeps: PictureDeps = {
  surface: browserSurface,
  bitmap: async (drawing) => {
    const source = await createImageBitmap(drawing);
    return { width: source.width, height: source.height, source };
  },
};

/** The picture of the view under the header lines the server gave, drawn as they are. */
export async function composePicture(drawing: Blob, header: readonly string[], deps: PictureDeps = browserDeps): Promise<Blob> {
  const bitmap = await deps.bitmap(drawing);
  const surface = deps.surface();
  const { context } = surface;
  context.font = HEADER_FONT;
  const textWidth = Math.max(0, ...header.map((line) => context.measureText(line).width));
  const width = Math.ceil(Math.max(bitmap.width + 2 * MARGIN, textWidth + 2 * BAND_PADDING, MIN_WIDTH));
  const band = bandHeightOf(header.length);
  const height = band + bitmap.height + 2 * MARGIN;
  surface.resize(width, height);
  // resizing a canvas resets its state
  context.fillStyle = CAPTION_KNOCKOUT;
  context.fillRect(0, 0, width, height);
  context.font = HEADER_FONT;
  context.textBaseline = 'middle';
  context.fillStyle = HEADER_COLOR;
  header.forEach((line, index) => context.fillText(line, BAND_PADDING, BAND_PADDING + index * LINE_HEIGHT + LINE_HEIGHT / 2));
  context.fillStyle = RULE_COLOR;
  context.fillRect(0, band - 1, width, 1);
  context.drawImage(bitmap.source, Math.round((width - bitmap.width) / 2), band + MARGIN);
  return surface.toBlob();
}
