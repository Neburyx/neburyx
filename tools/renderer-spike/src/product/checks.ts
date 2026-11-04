import { z } from 'zod';
import { RunnerError } from '../runner/errors.js';

/** What the product's canvas element says the renderer drew and where it looks (development builds only). */
export interface Readout {
  readonly entities: number;
  readonly relationships: number;
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

const numberText = z.string().transform(Number).pipe(z.number().finite());
const readoutSchema = z.object({ entities: numberText, relationships: numberText, zoom: numberText, panX: numberText, panY: numberText });

export type ReadoutValues = Partial<Record<keyof Readout, string | undefined>>;

/** Undefined when the canvas carries no complete read-out. */
export function parseReadout(values: ReadoutValues): Readout | undefined {
  const parsed = readoutSchema.safeParse(values);
  return parsed.success ? parsed.data : undefined;
}

export interface CanvasPixels {
  /** How many pixels of the canvas layers are not transparent. */
  readonly ink: number;
  /** A sample of the pixels folded into a number, so two pictures can be told apart. */
  readonly signature: string;
}

export const EXPECTED_ELEMENTS = 300;
/** A drag is exact in the library: the view moves by the pointer's distance, to within what a pixel round-off can add. */
export const DRAG_TOLERANCE_PX = 2;

export function checkDrawn(readout: Readout | undefined, notice: string | undefined, pixels: CanvasPixels): Readout {
  if (readout === undefined) throw new RunnerError('CANVAS_MISSING');
  if (notice !== undefined) throw new RunnerError('RENDERER_FAILED', notice);
  const drawn = readout.entities + readout.relationships;
  if (drawn !== EXPECTED_ELEMENTS) throw new RunnerError('PARTIAL_DRAW', `${readout.entities} entities and ${readout.relationships} relationships drawn, ${EXPECTED_ELEMENTS} elements expected`);
  if (pixels.ink === 0) throw new RunnerError('CANVAS_BLANK');
  return readout;
}

/** One wheel step changes the zoom by a factor between these, in the direction of the wheel. */
export const WHEEL_FACTOR = { min: 1.02, max: 2 } as const;
/** The opposite step must bring the zoom back to within this share of where it was. */
export const WHEEL_RETURN_TOLERANCE = 0.01;

/** A wheel turned away from the viewer (negative delta) zooms in, the other way zooms out, by a bounded factor; the renderer's own zoom must follow. */
export function checkWheel(before: Readout, after: Readout, deltaY: number): void {
  const factor = deltaY < 0 ? after.zoom / before.zoom : before.zoom / after.zoom;
  if (!(factor >= WHEEL_FACTOR.min && factor <= WHEEL_FACTOR.max)) throw new RunnerError('WHEEL_NO_EFFECT', `a step changed the zoom by a factor of ${factor.toFixed(3)}`);
}

export function checkWheelReturn(before: Readout, back: Readout): void {
  if (Math.abs(back.zoom - before.zoom) / before.zoom > WHEEL_RETURN_TOLERANCE) throw new RunnerError('WHEEL_NO_EFFECT', 'the opposite step did not bring the zoom back');
}

/** What a scripted run did to the view, read from the renderer's own figures while it ran. */
export interface Motion {
  /** The largest zoom seen over the smallest. */
  readonly zoomRatio: number;
  /** The total distance the pan moved, in pixels. */
  readonly panTravel: number;
}

export const MIN_MOTION = { zoomRatio: 1.2, panTravel: 200 } as const;

export function checkMotion(motion: Motion): void {
  if (!(motion.zoomRatio >= MIN_MOTION.zoomRatio && motion.panTravel >= MIN_MOTION.panTravel)) {
    throw new RunnerError('GESTURE_INEFFECTIVE', `the run changed the zoom by a factor of ${motion.zoomRatio.toFixed(2)} and moved the pan by ${motion.panTravel.toFixed(0)} px`);
  }
}

export function checkDrag(before: Readout, after: Readout, dx: number, dy: number, pictureBefore: CanvasPixels, pictureAfter: CanvasPixels): void {
  const exact = Math.abs(after.panX - before.panX - dx) <= DRAG_TOLERANCE_PX && Math.abs(after.panY - before.panY - dy) <= DRAG_TOLERANCE_PX;
  if (!exact) throw new RunnerError('DRAG_NO_EFFECT');
  if (pictureAfter.signature === pictureBefore.signature) throw new RunnerError('CANVAS_UNCHANGED');
}
