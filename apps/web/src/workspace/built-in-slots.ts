import { ZoomControls } from './zoom-controls.js';
import type { SlotRegistry } from './slots.js';

export function registerBuiltInSlots(registry: SlotRegistry): () => void {
  return registry.register('zoom-controls', ZoomControls);
}
