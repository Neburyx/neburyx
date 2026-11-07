export const BOX_WIDTH = 160;
export const BOX_HEIGHT = 94;
export const NEIGHBOUR_REACH = 400;
/** Entities further apart than this do not push each other in a layout run, so a spread-out graph does not keep growing: the push follows the same reach as a neighbour's placement. */
export const REPULSION_REACH = 400;
export const IDEAL_LENGTH = 220;
export const FORCE_STEPS = 60;
export const SEARCH_STEP = 20;
export const SEED_OFFSET = 90;
export const SPIRAL_STEP = 120;
/** How far an aggregate node is drawn from the node it belongs to. */
export const REMAINDER_RADIUS = 150;
/** How much further out the next ring of places for an aggregate node is. */
export const REMAINDER_RING_STEP = 110;
