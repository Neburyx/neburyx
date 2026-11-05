import pin from '../assets/lucide/pin.svg?raw';
import { PIN_BADGE_COLOR, PIN_BADGE_FILL, PIN_BADGE_SIZE } from './look.js';

const GLYPH_BOX = 24;
const GLYPH_ON_BADGE = 9;
const LUCIDE_BODY = /<svg[^>]*>([\s\S]*?)<\/svg>/;

/** The badge on a pinned entity: the library's pin glyph in the accent colour on a white disc with an accent ring, which cannot be mistaken for the filled amber badge a review flag takes. */
export function pinBadgeUri(): string {
  const body = LUCIDE_BODY.exec(pin)?.[1] ?? '';
  const half = PIN_BADGE_SIZE / 2;
  const scale = GLYPH_ON_BADGE / GLYPH_BOX;
  const offset = (PIN_BADGE_SIZE - GLYPH_ON_BADGE) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_BADGE_SIZE}" height="${PIN_BADGE_SIZE}" viewBox="0 0 ${PIN_BADGE_SIZE} ${PIN_BADGE_SIZE}"><circle cx="${half}" cy="${half}" r="${half - 0.75}" fill="${PIN_BADGE_FILL}" stroke="${PIN_BADGE_COLOR}" stroke-width="1.5"/><g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="${PIN_BADGE_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
