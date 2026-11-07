import type { ApiFailure } from './client.js';

/**
 * Hands the failure of a request to a presentation outside the store that made it (the request status banner). True when it was shown there, so the store keeps no failure line of its own;
 * false when nothing showed it, and the store presents it as before. `resend` asks the same request again.
 */
export type FailureReporter = (failure: ApiFailure, sourceId: string, resend: () => void) => boolean;
