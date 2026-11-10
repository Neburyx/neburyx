import type { ApiClient } from '../api/client.js';
import type { SlotRegistry } from '../workspace/slots.js';
import { InvestigationMenu } from './investigation-menu.js';

/** Puts the investigation menu in its header slot; the function returned takes it out again. */
export function registerInvestigationMenu(slots: SlotRegistry, client: ApiClient): () => void {
  return slots.register('investigation-menu', () => <InvestigationMenu client={client} />);
}
