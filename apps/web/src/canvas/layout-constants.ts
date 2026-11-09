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
/** Free space between two boxes in the grid layout. */
export const GRID_GAP_X = 40;
export const GRID_GAP_Y = 36;
/** Free space between two layers, and between two boxes in a layer, of the hierarchical layout. */
export const LAYER_GAP = 90;
export const LAYER_SIBLING_GAP = 40;
/** Free space between two boxes on a ring, and between two rings, of the radial layout. */
export const RING_GAP = 70;
export const RING_BOX_GAP = 30;
/** Live physics: how much of a force becomes speed in one frame, how much speed is kept, the most an entity travels in one frame, and the speed below which the arrangement counts as still. */
export const PHYSICS_PUSH = 0.012;
export const PHYSICS_DAMPING = 0.8;
export const PHYSICS_MAX_TRAVEL = 30;
export const PHYSICS_REST_SPEED = 0.2;
/** How many frames in a row the fastest entity must stay below the rest speed before the loop goes idle. */
export const PHYSICS_REST_FRAMES = 8;
/** The strength the forces start at after a disturbance, how much of it is left after each frame, and the strength below which the loop ends. */
export const PHYSICS_REHEAT = 0.7;
export const PHYSICS_ALPHA_DECAY = 0.975;
export const PHYSICS_ALPHA_MIN = 0.02;
/** After a change to the graph (not a drag) the forces start at a gentler strength, and whatever the frame rate the motion ends this many milliseconds after the last disturbance. */
export const PHYSICS_CHANGE_REHEAT = 0.3;
export const PHYSICS_MAX_MS = 1500;
/**
 * Live physics on a large canvas, from the frame rates measured at 4x CPU throttle on the 120-entity fixture grown by 25 at a time, dragging one entity:
 * up to 300 entities a frame is drawn at median 59.9 fps and 5th percentile 59.5 fps; 445 entities hold the same drawn every second frame; 595 and 995 fall below a 5th percentile of 30 fps even drawn every third frame.
 * So the drawing is made every frame up to PHYSICS_FULL_RATE_ENTITIES, every second frame up to PHYSICS_MAX_ENTITIES, and above that the switch is disabled.
 */
export const PHYSICS_FULL_RATE_ENTITIES = 300;
export const PHYSICS_MAX_ENTITIES = 450;
export const physicsStride = (entities: number): number => (entities <= PHYSICS_FULL_RATE_ENTITIES ? 1 : 2);
