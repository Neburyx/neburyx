export const NODE_OUTER_DIAMETER = 36;
export const NODE_OUTLINE_WIDTH = 1;
/** Cytoscape draws the outline centred on the disc's edge, so the disc is one outline narrower than the 36 px the design measures across its outline. */
export const NODE_DIAMETER = NODE_OUTER_DIAMETER - NODE_OUTLINE_WIDTH;
export const NODE_OUTLINE = '#cad0da';
export const NODE_FILL = '#ffffff';
export const EDGE_COLOR = '#8c96a8';
export const EDGE_WIDTH = 1.4;
export const FIT_PADDING = 48;
export const GLYPH_COLOR = '#747a85';
export const GLYPH_SIZE = 18;
export const CAPTION_COLOR = '#4a5261';
export const CAPTION_KNOCKOUT = '#fafbfc';
export const CAPTION_HALO = 'rgba(250, 251, 252, 0.92)';
export const DERIVED_COLOR = '#5264a7';
export const AGGREGATE_WIDTH = 3.5;
export const DASH_PATTERN = [6, 5];
export const DOT_PATTERN = [1.4, 4];
export const ARROW_SHAPE = 'chevron';
export const ARROW_GAP = 2;
export const LABEL_FILL = '#fafbfc';
export const PILL_FILL = '#ffffff';
export const PILL_OUTLINE_WIDTH = 1.5;
export const LABEL_FONT_SIZE = 12;
export const SELECTED_COLOR = DERIVED_COLOR;
export const SELECTED_OUTLINE_WIDTH = 1.8;
export const SELECTED_HALO_COLOR = DERIVED_COLOR;
export const SELECTED_HALO_OPACITY = 0.0941;
export const SELECTED_HALO_DIAMETER = 48;
export const SELECTED_LINE_EXTRA = 1;
/** The library measures the halo's padding from the disc without its outline, so the halo is the design's diameter when the padding is this. */
export const SELECTED_HALO_PADDING = (SELECTED_HALO_DIAMETER - (NODE_OUTER_DIAMETER - SELECTED_OUTLINE_WIDTH)) / 2;
/** The accent, as the focus ring of the page is (`--color-focus`); it is told apart from the selection, which has the same colour, by shape: a ring with a gap round the disc, against an outline on it and a faint halo. */
export const FOCUS_COLOR = DERIVED_COLOR;
/** The width of the focus mark, as `--focus-width` is on the page. */
export const FOCUS_RING_WIDTH = 1.5;
export const FOCUS_RING_GAP = 2;
export const PIN_BADGE_SIZE = 16;
export const PIN_BADGE_COLOR = DERIVED_COLOR;
export const PIN_BADGE_FILL = NODE_FILL;
export const CAPTION_FONT_SIZE = 12;
/** The smallest size, in screen pixels, at which caption text is read; below it the captions and labels are left out. */
export const MIN_LEGIBLE_FONT_SIZE = 7;
/** How far under the disc or the middle of a line the readable caption of a hovered element hangs, in screen pixels. */
export const TIP_GAP = 8;
export const CAPTION_MIN_ZOOM = MIN_LEGIBLE_FONT_SIZE / CAPTION_FONT_SIZE;
