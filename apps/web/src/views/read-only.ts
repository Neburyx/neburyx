import type { ApiFailure } from '../api/client.js';
import { isReadOnlyRefusal } from '../lifecycle/status-flow.js';
import type { ClientState } from '../state/client-state.js';

/** Notes that the investigation shown was refused as closed or archived (changed in another tab), so that its Save and view controls stop at once; true when the failure was that refusal. */
export function noteReadOnlyRefusal(state: ClientState, failure: ApiFailure): boolean {
  if (!isReadOnlyRefusal(failure)) return false;
  const held = state.investigation.getState().record;
  const status = 'details' in failure ? failure.details?.status : undefined;
  if (held !== null && status !== undefined) state.describeInvestigation({ ...held, status, readOnly: true });
  return true;
}
