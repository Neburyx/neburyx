import type { ApiClient } from '../api/client.js';
import type { SlotRegistry } from '../workspace/slots.js';
import { ExportButton } from './export-button.js';

/** Puts the Export button in its header slot; the function returned takes it out again. */
export function registerExport(slots: SlotRegistry, client: ApiClient): () => void {
  return slots.register('export', () => <ExportButton client={client} />);
}
