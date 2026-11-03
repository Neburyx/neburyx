export const RUNNER_ERROR_CODES = ['ADAPTER_UNKNOWN', 'BUILD_MISSING', 'SERVER_START_FAILED', 'BROWSER_START_FAILED', 'ADAPTER_FAILED', 'MEASUREMENT_FAILED', 'CLEANUP_FAILED', 'USAGE'] as const;

export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;

  constructor(code: RunnerErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'RunnerError';
    this.code = code;
  }
}
