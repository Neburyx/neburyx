import type { SlotRegistry } from '../workspace/slots.js';
import { AiHeaderControl } from './ai-header-control.js';

/** Puts Ask and Summarize in their header slots; the function returned takes them out again. */
export function registerAiControls(slots: SlotRegistry): () => void {
  const removals = [slots.register('ask', () => <AiHeaderControl action="ask" />), slots.register('summarize', () => <AiHeaderControl action="summarize" />)];
  return () => removals.forEach((remove) => remove());
}
