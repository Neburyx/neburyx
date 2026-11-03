export const CAPTION_WIDTH = 160;
export const CAPTION_HEIGHT = 38;
export const KNOCKOUT_PADDING = 3;
export const LINE_HEIGHT = 17;
export const LINE_GAP = 2;
export const HALO_TOP = 1;
export const HALO_RADIUS = 4;
export const CAPTION_TOP = 41;
const ELLIPSIS = '…';

/** Cuts the text, with an ellipsis, to the longest start that fits the width as `measure` measures it; the search is by halving, so a very long text costs few measurements. */
export function fitText(measure: (text: string) => number, text: string, maxWidth: number): string {
  if (measure(text) <= maxWidth) return text;
  let fits = 0;
  let over = text.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (measure(`${text.slice(0, middle)}${ELLIPSIS}`) <= maxWidth) fits = middle;
    else over = middle;
  }
  return `${text.slice(0, fits)}${ELLIPSIS}`;
}

export interface CaptionBox {
  readonly line1: string;
  readonly line2: string;
  readonly knockout1: number;
  readonly knockout2: number;
  readonly halo: number;
}

/** Each line sits on a knockout 3 px wider than the text on each side; the halo is 6 px wider than the wider knockout. */
export function captionBox(measure1: (text: string) => number, measure2: (text: string) => number, line1: string, line2: string): CaptionBox {
  const room = CAPTION_WIDTH - 2 * KNOCKOUT_PADDING;
  const first = fitText(measure1, line1, room);
  const second = fitText(measure2, line2, room);
  const knockout1 = measure1(first) + 2 * KNOCKOUT_PADDING;
  const knockout2 = measure2(second) + 2 * KNOCKOUT_PADDING;
  return { line1: first, line2: second, knockout1, knockout2, halo: Math.min(CAPTION_WIDTH, Math.max(knockout1, knockout2) + 2 * KNOCKOUT_PADDING) };
}
