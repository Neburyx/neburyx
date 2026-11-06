import type { Viewport } from '../state/presentation-state.js';
import { FIT_ZOOM_MAX } from './zoom.js';

export interface Box {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** The view that centres `box` (in graph coordinates) in `size` with `padding` on every side: the largest zoom that shows all of it, capped at `FIT_ZOOM_MAX` and not limited below, so even a very spread box fits. When the padding takes the whole canvas the margin is dropped. Undefined when the canvas has no area. */
export function fitViewport(box: Box, size: Size, padding: number): Viewport | undefined {
  if (!(size.width > 0 && size.height > 0)) return undefined;
  const width = box.x2 - box.x1;
  const height = box.y2 - box.y1;
  const within = (margin: number): number => Math.min((size.width - 2 * margin) / width, (size.height - 2 * margin) / height);
  const wanted = within(padding) > 0 ? within(padding) : within(0);
  const zoom = Number.isNaN(wanted) ? FIT_ZOOM_MAX : Math.min(FIT_ZOOM_MAX, wanted);
  return { zoom, x: (size.width - zoom * (box.x1 + box.x2)) / 2, y: (size.height - zoom * (box.y1 + box.y2)) / 2 };
}
