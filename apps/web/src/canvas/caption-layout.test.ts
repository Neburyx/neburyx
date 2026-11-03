import { describe, expect, it } from 'vitest';
import { CAPTION_WIDTH, captionBox, fitText } from './caption-layout.js';

const mono = (text: string) => text.length * 7;
const sans = (text: string) => text.length * 6;

describe('fitText', () => {
  it('leaves a text that fits, and cuts one that does not with an ellipsis within the width', () => {
    expect(fitText(mono, 'ACC-1', 100)).toBe('ACC-1');
    const cut = fitText(mono, 'A'.repeat(60), 100);
    expect(cut.endsWith('…')).toBe(true);
    expect(mono(cut)).toBeLessThanOrEqual(100);
  });

  it('gives only the ellipsis when not even one letter fits', () => {
    expect(fitText(mono, 'ABC', 3)).toBe('…');
  });
});

describe('fitText on a very long text', () => {
  it('measures only a few times for a 10,000 character title, and still fits', () => {
    let measures = 0;
    const counting = (text: string) => {
      measures += 1;
      return mono(text);
    };
    const cut = fitText(counting, 'T'.repeat(10_000), 100);
    expect(measures).toBeLessThan(30);
    expect(mono(cut)).toBeLessThanOrEqual(100);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('gives the longest start that fits', () => {
    const cut = fitText(mono, 'A'.repeat(60), 100);
    expect(mono(cut)).toBeLessThanOrEqual(100);
    expect(mono(`${'A'.repeat(cut.length)}…`)).toBeGreaterThan(100);
  });
});

describe('the caption box', () => {
  it('puts each line on a knockout 3 px wider than its text on each side and a halo 6 px wider than the wider one, as frame 04 does', () => {
    const box = captionBox(mono, sans, 'ACC-71825', 'Account · Active');
    expect(box.knockout1).toBe(9 * 7 + 6);
    expect(box.knockout2).toBe(16 * 6 + 6);
    expect(box.halo).toBe(box.knockout2 + 6);
  });

  it('keeps both lines and the halo within the caption width, cutting a long title and a long detail', () => {
    const box = captionBox(mono, sans, 'T'.repeat(120), 'D'.repeat(120));
    expect(box.knockout1).toBeLessThanOrEqual(CAPTION_WIDTH);
    expect(box.knockout2).toBeLessThanOrEqual(CAPTION_WIDTH);
    expect(box.halo).toBeLessThanOrEqual(CAPTION_WIDTH);
    expect(box.line1.endsWith('…')).toBe(true);
    expect(box.line2.endsWith('…')).toBe(true);
  });
});
