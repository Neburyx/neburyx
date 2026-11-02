import { AppError } from '../errors.js';

export const UNSUPPORTED_VERSION_REASON = 'The server version is not on the support matrix.';
export const PRIVILEGES_UNREADABLE_REASON = 'The server listed privileges that could not be read, so read-only is not verified.';
export const NOT_CHECKED_SINCE_START = 'The source has not been checked since the start.';
export const FIX_THE_SOURCE = 'Fix the source, then run test-source or test it from the Sources page.';
export const LOGIN_CAN_WRITE_REASON = 'The login can write to the source; give Neburyx a login that can only read.';

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

/**
 * Whether a failure of the privileges read means the login's privileges could not be inspected, which is a result of its own (`not-verified`): the server refused the read,
 * it timed out, the connection failed, or the adapter could not run it. Anything else (a busy source, a full pool, a closed executor, a failure of another stage) is rethrown.
 */
export function isReadNotVerified(error: unknown): boolean {
  if (failureReasonOf(error) !== undefined) return true;
  return error instanceof AppError && error.code === 'INTERNAL_ERROR' && error.reason === 'read-failed';
}
