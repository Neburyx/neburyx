import { CARD_BADGE_SIZE, DERIVED_COLOR, NODE_FILL } from './look.js';

const FONT_SIZE = 12;
const TEXT_BASELINE = 4;

/** The badge on the corner of a group's card: its member count in white on a disc of the accent colour. */
export function groupBadgeUri(count: number): string {
  const half = CARD_BADGE_SIZE / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_BADGE_SIZE}" height="${CARD_BADGE_SIZE}" viewBox="0 0 ${CARD_BADGE_SIZE} ${CARD_BADGE_SIZE}"><circle cx="${half}" cy="${half}" r="${half}" fill="${DERIVED_COLOR}"/><text x="${half}" y="${half + TEXT_BASELINE}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="${FONT_SIZE}" font-weight="600" fill="${NODE_FILL}">${count}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
