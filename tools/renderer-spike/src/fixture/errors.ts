export const FIXTURE_ERROR_CODES = ['FIXTURE_PARAMETER_INVALID', 'FIXTURE_INVALID'] as const;

export type FixtureErrorCode = (typeof FIXTURE_ERROR_CODES)[number];

export class FixtureError extends Error {
  readonly code: FixtureErrorCode;
  readonly parameter: string | undefined;

  constructor(code: FixtureErrorCode, parameter?: string) {
    super(parameter === undefined ? code : `${code}: ${parameter}`);
    this.name = 'FixtureError';
    this.code = code;
    this.parameter = parameter;
  }
}
