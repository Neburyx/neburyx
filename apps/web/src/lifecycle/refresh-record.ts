import type { ApiClient } from '../api/client.js';
import type { ClientState } from '../state/client-state.js';
import { readOnlyOf } from '../state/investigation-state.js';

/** Reads the investigation again and puts its title, status and version in the record on screen; false when it could not be read or another investigation is shown now. */
export async function refreshRecord(client: ApiClient, state: ClientState, id: string): Promise<boolean> {
  const read = await client.getInvestigation(id);
  if (!read.ok) return false;
  const held = state.investigation.getState();
  if (held.id !== id || held.record === null) return false;
  const { investigation } = read.value;
  state.describeInvestigation({ ...held.record, title: investigation.title, status: investigation.status, readOnly: readOnlyOf(investigation.status, investigation.sourceState), sourceState: investigation.sourceState, version: investigation.version });
  return true;
}
