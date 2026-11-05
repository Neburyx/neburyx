import { describe, expect, it } from 'vitest';
import { PIN_BADGE_COLOR, PIN_BADGE_SIZE } from './look.js';
import { pinBadgeUri } from './pin-badge.js';

const svgOf = (): string => decodeURIComponent(pinBadgeUri().replace('data:image/svg+xml;utf8,', ''));

describe('the pin badge', () => {
  it('is an svg image of the badge size, with the library\'s pin glyph inside', () => {
    const svg = svgOf();
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain(`width="${PIN_BADGE_SIZE}"`);
    expect(svg).toContain('M12 17v5');
    expect(svg).not.toContain('<svg class="lucide');
  });

  it('is drawn in the accent colour on a white disc, not filled in amber like a review flag', () => {
    const svg = svgOf();
    expect(svg).toContain(`stroke="${PIN_BADGE_COLOR}"`);
    expect(svg).toContain('fill="#ffffff"');
    expect(svg.toLowerCase()).not.toMatch(/#db850d|amber/);
  });
});
