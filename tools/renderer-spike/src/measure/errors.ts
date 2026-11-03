export const MEASURE_ERROR_CODES = ['FRAME_TIMESTAMPS_INVALID', 'REPORT_INVALID', 'POSITIONS_UNAVAILABLE', 'FOCUS_ORDER_EMPTY', 'DURATION_INVALID', 'REPORT_WRITE_FAILED'] as const;

export type MeasureErrorCode = (typeof MEASURE_ERROR_CODES)[number];

export class MeasureError extends Error {
  readonly code: MeasureErrorCode;

  constructor(code: MeasureErrorCode) {
    super(code);
    this.name = 'MeasureError';
    this.code = code;
  }
}
