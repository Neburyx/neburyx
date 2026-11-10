import { Toggles } from './legend-toggle.js';
import { ToolStrip } from './tool-strip.js';
import { ZoomControls } from './zoom-controls.js';
import { SaveControl } from '../views/save-control.js';
import { ViewsControl } from '../views/views-control.js';
import type { SlotRegistry } from './slots.js';

export function registerBuiltInSlots(registry: SlotRegistry): () => void {
  const removals = [registry.register('tool-strip', ToolStrip), registry.register('toggles', Toggles), registry.register('zoom-controls', ZoomControls), registry.register('save', SaveControl), registry.register('views', ViewsControl)];
  return () => {
    for (const remove of removals) remove();
  };
}
