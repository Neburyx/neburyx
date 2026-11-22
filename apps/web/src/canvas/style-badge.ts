import type { StyleTone } from '@neburyx/contracts';
import { NODE_FILL, STYLE_BADGE_SIZE, STYLE_TONE_COLORS } from './look.js';

const MARK_WIDTH = 2;
const MARK_TOP = 3.5;
const MARK_BOTTOM = 9;
const DOT_Y = 12;
const DOT_RADIUS = 1.2;

/** The badge of a style rule: a disc of the tone with a white exclamation mark, as the amber badge of frame 04e. */
export function styleBadgeUri(tone: StyleTone): string {
  const half = STYLE_BADGE_SIZE / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${STYLE_BADGE_SIZE}" height="${STYLE_BADGE_SIZE}" viewBox="0 0 ${STYLE_BADGE_SIZE} ${STYLE_BADGE_SIZE}"><circle cx="${half}" cy="${half}" r="${half}" fill="${STYLE_TONE_COLORS[tone]}"/><line x1="${half}" y1="${MARK_TOP}" x2="${half}" y2="${MARK_BOTTOM}" stroke="${NODE_FILL}" stroke-width="${MARK_WIDTH}" stroke-linecap="round"/><circle cx="${half}" cy="${DOT_Y}" r="${DOT_RADIUS}" fill="${NODE_FILL}"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
