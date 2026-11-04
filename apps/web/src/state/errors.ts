export const STATE_ERROR_CODES = ['UNKNOWN_ELEMENT', 'SOURCE_MISMATCH', 'NO_SOURCE_BOUND', 'INVALID_TIME', 'INVALID_VIEWPORT'] as const;

export type StateErrorCode = (typeof STATE_ERROR_CODES)[number];

export class StateError extends Error {
  readonly code: StateErrorCode;

  constructor(code: StateErrorCode) {
    super(code);
    this.name = 'StateError';
    this.code = code;
  }
}
