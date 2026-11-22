import { describe, expect, it } from 'vitest';
import { bandHeightOf, composePicture, drawingBoundsFor, MAX_PICTURE_AREA, MAX_PICTURE_EDGE, type PictureContext, type PictureDeps } from './picture.js';

interface Recorded {
  readonly size: { width: number; height: number };
  readonly texts: Array<{ readonly text: string; readonly x: number; readonly y: number }>;
  readonly images: Array<{ readonly x: number; readonly y: number }>;
  readonly fills: Array<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number }>;
}

function fakes(bitmap: { readonly width: number; readonly height: number }, charWidth = 8): { readonly deps: PictureDeps; readonly recorded: Recorded } {
  const recorded: Recorded = { size: { width: 0, height: 0 }, texts: [], images: [], fills: [] };
  const context: PictureContext = {
    font: '',
    fillStyle: '',
    textBaseline: 'alphabetic',
    measureText: (text) => ({ width: text.length * charWidth }),
    fillRect: (x, y, width, height) => void recorded.fills.push({ x, y, width, height }),
    fillText: (text, x, y) => void recorded.texts.push({ text, x, y }),
    drawImage: (_image, x, y) => void recorded.images.push({ x, y }),
  };
  return {
    recorded,
    deps: {
      bitmap: () => Promise.resolve({ ...bitmap, source: {} as CanvasImageSource }),
      surface: () => ({
        context,
        resize: (width, height) => {
          recorded.size.width = width;
          recorded.size.height = height;
        },
        toBlob: () => Promise.resolve(new Blob(['png'], { type: 'image/png' })),
      }),
    },
  };
}

const LINES = ['source: demo', 'exported time: 10 Nov 2026, 10:15:00 UTC', 'scope: current view (partial)', 'coverage: 10 shown · ~38 not yet retrieved (estimated)', 'masking: off'];

describe('the picture of a view under its header', () => {
  it('draws the header lines as the server gave them, in order, above the drawing', async () => {
    const { deps, recorded } = fakes({ width: 900, height: 500 });
    await composePicture(new Blob(), LINES, deps);
    expect(recorded.texts.map((entry) => entry.text)).toEqual(LINES);
    expect(recorded.texts.map((entry) => entry.y)).toEqual([...recorded.texts.map((entry) => entry.y)].sort((a, b) => a - b));
    const band = bandHeightOf(LINES.length);
    expect(Math.max(...recorded.texts.map((entry) => entry.y))).toBeLessThan(band);
    expect(recorded.images).toEqual([{ x: expect.any(Number), y: expect.any(Number) }]);
    expect(recorded.images[0]?.y).toBeGreaterThanOrEqual(band);
  });

  it('is as wide as its widest header line when the drawing is narrow, and holds the whole drawing', async () => {
    const { deps, recorded } = fakes({ width: 200, height: 100 }, 20);
    await composePicture(new Blob(), LINES, deps);
    const widest = Math.max(...LINES.map((line) => line.length * 20));
    expect(recorded.size.width).toBeGreaterThanOrEqual(widest);
    expect(recorded.size.height).toBeGreaterThan(bandHeightOf(LINES.length) + 100);
  });

  it('stays within both bounds when the drawing is as large as the drawing bounds allow', async () => {
    const bounds = drawingBoundsFor();
    const wide = fakes({ width: bounds.maxWidth, height: Math.floor(bounds.maxArea / bounds.maxWidth) });
    await composePicture(new Blob(), [...LINES, 'Some items may be hidden by your access.'], wide.deps);
    const tall = fakes({ width: Math.floor(bounds.maxArea / bounds.maxHeight), height: bounds.maxHeight });
    await composePicture(new Blob(), [...LINES, 'Some items may be hidden by your access.'], tall.deps);
    for (const { recorded } of [wide, tall]) {
      expect(Math.max(recorded.size.width, recorded.size.height)).toBeLessThanOrEqual(MAX_PICTURE_EDGE);
      expect(recorded.size.width * recorded.size.height).toBeLessThanOrEqual(MAX_PICTURE_AREA);
    }
  });

  it('rejects when the picture cannot be encoded', async () => {
    const { deps } = fakes({ width: 10, height: 10 });
    const failing: PictureDeps = { ...deps, surface: () => ({ ...deps.surface(), toBlob: () => Promise.reject(new Error('the picture could not be encoded')) }) };
    await expect(composePicture(new Blob(), LINES, failing)).rejects.toThrow('encoded');
  });
});
