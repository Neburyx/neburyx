import type { Viewport } from '../state/presentation-state.js';

export const READOUT_MARKER = 'neburyx-dev-canvas-readout';

export interface Readout {
  readonly entities: number;
  readonly relationships: number;
  readonly viewport: Viewport;
}

/** Development builds only: puts what the renderer itself drew and where it is looking on the canvas element, so a measurement can tell a drawing from a page that only loaded the records. */
export function writeReadout(element: HTMLElement, readout: Readout): void {
  element.dataset['devReadout'] = READOUT_MARKER;
  element.dataset['drawnEntities'] = String(readout.entities);
  element.dataset['drawnRelationships'] = String(readout.relationships);
  element.dataset['zoom'] = String(readout.viewport.zoom);
  element.dataset['panX'] = String(readout.viewport.x);
  element.dataset['panY'] = String(readout.viewport.y);
}
