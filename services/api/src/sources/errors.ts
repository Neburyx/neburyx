export type AdapterErrorCode = 'NOT_READ_ONLY' | 'READ_FAILED';

const MESSAGES: Readonly<Record<AdapterErrorCode, string>> = {
  NOT_READ_ONLY: 'The source adapter only runs read calls.',
  READ_FAILED: 'The source could not run the read.',
};

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode) {
    super(MESSAGES[code]);
    this.name = 'AdapterError';
    this.code = code;
  }
}

export type FailureKind = 'timeout' | 'unreachable' | 'pool-full' | 'authentication' | 'database' | 'refused' | 'other';

const TIMEOUT_FAMILY = 'Neo.ClientError.Transaction.TransactionTimedOut';
const CONNECTION_CODES: ReadonlySet<string> = new Set(['ServiceUnavailable', 'SessionExpired']);
const AUTHENTICATION_CODES: ReadonlySet<string> = new Set([
  'Neo.ClientError.Security.Unauthorized',
  'Neo.ClientError.Security.AuthenticationRateLimit',
  'Neo.ClientError.Security.CredentialsExpired',
]);
const DATABASE_CODES: ReadonlySet<string> = new Set(['Neo.ClientError.Database.DatabaseNotFound']);
const REFUSED_CODES: ReadonlySet<string> = new Set(['Neo.ClientError.Security.Forbidden']);
const REFUSED_PREFIX = 'Neo.ClientError.Procedure.';
const ACQUISITION_TIMEOUT = 'Connection acquisition timed out';
const SERVER_CODE = /^Neo\.[A-Za-z]+\.[A-Za-z]+\.[A-Za-z]+$/;

function fieldOf(error: unknown, name: 'code' | 'message'): string {
  if (typeof error !== 'object' || error === null || !(name in error)) return '';
  const value: unknown = Reflect.get(error, name);
  return typeof value === 'string' ? value : '';
}

export function classify(error: unknown): FailureKind {
  const code = fieldOf(error, 'code');
  if (code.startsWith(TIMEOUT_FAMILY)) return 'timeout';
  if (AUTHENTICATION_CODES.has(code)) return 'authentication';
  if (CONNECTION_CODES.has(code)) return 'unreachable';
  if (DATABASE_CODES.has(code)) return 'database';
  if (REFUSED_CODES.has(code) || code.startsWith(REFUSED_PREFIX)) return 'refused';
  // the driver raises the pool wait as a general error with no code of its own
  if (fieldOf(error, 'message').startsWith(ACQUISITION_TIMEOUT)) return 'pool-full';
  return 'other';
}

/** The server's own error code when the error carries one, which names no query text, parameter or row. */
export function serverCodeOf(error: unknown): string | undefined {
  const code = fieldOf(error, 'code');
  return SERVER_CODE.test(code) ? code : undefined;
}
