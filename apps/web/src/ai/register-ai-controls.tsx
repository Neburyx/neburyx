import type { SlotRegistry } from '../workspace/slots.js';
import { AiHeaderControl } from './ai-header-control.js';

/** Puts Summarize in its header slot; the function returned takes it out again. Ask has no control until the rebuilt Ask panel lands. */
export function registerAiControls(slots: SlotRegistry): () => void {
  const removals = [slots.register('summarize', () => <AiHeaderControl action="summarize" />)];
  return () => removals.forEach((remove) => remove());
}
