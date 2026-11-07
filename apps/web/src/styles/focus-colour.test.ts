// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOCUS_COLOR, FOCUS_RING_WIDTH } from '../canvas/look.js';

const tokens = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');
const token = (name: string): string => {
  const found = new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1]?.trim();
  if (found === undefined) throw new Error(`NO_TOKEN_${name}`);
  const alias = /^var\((--[\w-]+)\)$/.exec(found)?.[1];
  return alias === undefined ? found : token(alias);
};

function luminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (red as number) + 0.7152 * (green as number) + 0.0722 * (blue as number);
}
const contrast = (first: string, second: string): number => {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return ((high as number) + 0.05) / ((low as number) + 0.05);
};

describe('the focus colour', () => {
  it('is the accent of the design, in the page and on the canvas, from one token', () => {
    expect(token('--color-focus')).toBe(token('--color-accent'));
    expect(FOCUS_COLOR.toLowerCase()).toBe(token('--color-accent').toLowerCase());
  });

  it('reaches 3:1 against every surface it is drawn on', () => {
    for (const surface of ['--color-surface', '--color-canvas', '--color-surface-muted', '--color-row-chosen', '--color-accent-surface', '--color-workspace-border']) {
      expect(contrast(FOCUS_COLOR, token(surface)), surface).toBeGreaterThanOrEqual(3);
    }
  });

  it('has one width, on the page and on the canvas, and it is a light one', () => {
    expect(token('--focus-width')).toBe(`${FOCUS_RING_WIDTH}px`);
    expect(FOCUS_RING_WIDTH).toBeLessThanOrEqual(1.5);
  });
});
