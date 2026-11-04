import { useCanvasCommands } from '../canvas/canvas-commands.js';
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../canvas/zoom.js';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';

const NEUTRAL_ZOOM = 1;

export function ZoomControls() {
  const state = useClientState();
  const commands = useCanvasCommands();
  const zoom = useStoreSelector(state.presentation.view, (current) => current.viewport?.zoom) ?? NEUTRAL_ZOOM;
  const hasEntities = useLoadedGraph().nodes.length > 0;
  return (
    <div className="zoom-controls" role="group" aria-label="Zoom">
      <button type="button" className="zoom-button" aria-label="Zoom out" disabled={commands === undefined || zoom <= ZOOM_MIN} onClick={() => commands?.zoomBy(1 / ZOOM_STEP)}>
        <span aria-hidden="true">−</span>
      </button>
      <span className="zoom-percentage">{Math.round(zoom * 100)}%</span>
      <button type="button" className="zoom-button" aria-label="Zoom in" disabled={commands === undefined || zoom >= ZOOM_MAX} onClick={() => commands?.zoomBy(ZOOM_STEP)}>
        <span aria-hidden="true">+</span>
      </button>
      <button type="button" className="zoom-button zoom-button-fit" aria-label="Fit to view" disabled={commands === undefined || !hasEntities} onClick={() => commands?.fit()}>
        <span className="icon icon-fit" aria-hidden="true" />
      </button>
    </div>
  );
}
