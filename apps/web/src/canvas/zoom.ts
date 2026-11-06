/** Provisional values: the sources give none. The wheel and the buttons stay between the limits; a fit may go below the minimum. */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 1.25;
/** The most a fit zooms in: a graph that would fill the canvas at a larger zoom is shown at 100%. Zooming by hand still goes to `ZOOM_MAX`. */
export const FIT_ZOOM_MAX = 1;
