import type { ApiFailure } from '../api/client.js';

/** A failure that says the assistant itself is off or not set up: the words of the assistant, never those of Ask. */
export const isAssistantOff = (failure: ApiFailure): boolean =>
  failure.code === 'ASK_UNSUPPORTED' || (failure.code === 'ACCESS_DENIED' && 'details' in failure && failure.details !== undefined && Object.getOwnPropertyDescriptor(failure.details, 'reason')?.value === 'ai-off');

/** A refusal that says the investigation is no longer the person's: what the panel shows of it is cleared. */
export const isAccessLost = (failure: ApiFailure): boolean => failure.code === 'NOT_FOUND' || (failure.code === 'ACCESS_DENIED' && !isAssistantOff(failure));
