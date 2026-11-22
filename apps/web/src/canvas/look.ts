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
/** The accent: the colour of derived links, of the selection and its halo, of the focus ring (`--color-focus`) and of the pin badge. The focus ring is told apart from the selection, which has the same colour, by shape: a ring with a gap round the disc, against an outline on it and a faint halo. */
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
export const SELECTED_OUTLINE_WIDTH = 1.8;
export const SELECTED_HALO_OPACITY = 0.0941;
const SELECTED_HALO_DIAMETER = 48;
export const SELECTED_LINE_EXTRA = 1;
/** The library measures the halo's padding from the disc without its outline, so the halo is the design's diameter when the padding is this. */
export const SELECTED_HALO_PADDING = (SELECTED_HALO_DIAMETER - (NODE_OUTER_DIAMETER - SELECTED_OUTLINE_WIDTH)) / 2;
/** The width of the focus mark, as `--focus-width` is on the page. */
export const FOCUS_RING_WIDTH = 1.5;
export const FOCUS_RING_GAP = 2;
export const PIN_BADGE_SIZE = 16;
/** The colours of the tones a style rule may take, as `--style-tone-*` are on the page; each differs from the plain outline and from the accent of the selection and the focus ring. */
export const STYLE_TONE_COLORS = { amber: '#e8890c', red: '#c6303e', green: '#2e8b57', blue: '#2c7be5', gray: '#59616f' } as const;
/** The badge a rule puts on a node: a disc of its tone with a white mark, sized as the pin badge and on the rim at 45 degrees to the upper right (frame 04e). */
export const STYLE_BADGE_SIZE = 16;
/** A node a rule enlarges is this many times its usual diameter. */
export const STYLE_LARGER_FACTOR = 1.5;
/** The width of the outline of a node a rule colours, in place of the plain outline's. */
export const STYLE_COLOR_OUTLINE_WIDTH = 2;
export const CAPTION_FONT_SIZE = 12;
/** The smallest size, in screen pixels, at which caption text is read; below it the captions and labels are left out. */
export const MIN_LEGIBLE_FONT_SIZE = 7;
/** How far under the disc or the middle of a line the readable caption of a hovered element hangs, in screen pixels. */
export const TIP_GAP = 8;
export const CAPTION_MIN_ZOOM = MIN_LEGIBLE_FONT_SIZE / CAPTION_FONT_SIZE;
/** The card of a collapsed group: a rounded box that holds its name and "n loaded", with a corner badge of the member count and a second outline behind it (frame 04f). */
export const CARD_WIDTH = 112;
export const CARD_HEIGHT = 52;
export const CARD_BADGE_SIZE = 22;
export const CARD_BADGE_OFFSET = -8;
export const CARD_GLYPH_INSET = 10;
export const CARD_STACK_PADDING = 7;
export const CARD_STACK_OPACITY = 0.18;
export const CARD_FONT_SIZE = 12;
