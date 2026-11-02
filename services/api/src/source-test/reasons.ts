import { AppError } from '../errors.js';

export const UNSUPPORTED_VERSION_REASON = 'The server version is not on the support matrix.';

export type FailureReason = 'unreachable' | 'authentication' | 'credentials' | 'database' | 'refused' | 'timeout';

export const FAILURE_SENTENCES: Readonly<Record<FailureReason, string>> = {
  unreachable: 'The source could not be reached.',
  authentication: 'The source refused the sign-in.',
  credentials: 'The credentials named in the mapping are not set.',
  database: 'The database named in the mapping does not exist on the server.',
  refused: 'The source refused the read.',
  timeout: 'The source did not answer in time.',
};

/**
 * The reason a gate failure says something about the source, or undefined when it does not
 * (a busy or full pool, a closed executor, a refusal by the policy, an internal error): those are rethrown, not reported.
 */
export function failureReasonOf(error: unknown): FailureReason | undefined {
  if (!(error instanceof AppError)) return undefined;
  if (error.code === 'QUERY_TIMEOUT') return 'timeout';
  if (error.code !== 'SOURCE_UNAVAILABLE') return undefined;
  switch (error.reason) {
    case 'unreachable':
    case 'authentication':
    case 'credentials':
    case 'database':
    case 'refused':
      return error.reason;
    default:
      return undefined;
  }
}
