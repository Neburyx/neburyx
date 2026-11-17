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
const REFUSED_CODES: ReadonlySet<string> = new Set([
  'Neo.ClientError.Security.Forbidden',
  // a Community server answers an administration command this way, and a user database answers it to a statement that belongs to the system database
  'Neo.ClientError.Statement.UnsupportedAdministrationCommand',
  'Neo.ClientError.Statement.NotSystemDatabaseError',
]);
const REFUSED_PREFIX = 'Neo.ClientError.Procedure.';
const ACQUISITION_TIMEOUT = 'Connection acquisition timed out';
/**
 * The driver's own text for a wait that ran out (neo4j-driver 6.3.0, `getAcquisitionTimeoutError`): "Connection acquisition timed out in 2000 ms. Pool status: Active conn count = 0, Idle conn count = 0."
 * A connection counts as active once it is made, so no active connection and no idle one means that the wait was spent making the first connection: the source did not connect in time, which is
 * not a full pool. A text that does not have this shape (another driver version) stays a full pool, as before; the test that pins the text fails when an upgrade changes it.
 */
const POOL_STATUS = /^Connection acquisition timed out in \d+ ms\. Pool status: Active conn count = (\d+), Idle conn count = (\d+)\./;

function nothingConnected(message: string): boolean {
  const found = POOL_STATUS.exec(message);
  return found?.[1] === '0' && found[2] === '0';
}

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
  const message = fieldOf(error, 'message');
  if (message.startsWith(ACQUISITION_TIMEOUT)) return nothingConnected(message) ? 'unreachable' : 'pool-full';
  return 'other';
}

/** The server's own error code when the error carries one, which names no query text, parameter or row. */
export function serverCodeOf(error: unknown): string | undefined {
  const code = fieldOf(error, 'code');
  return SERVER_CODE.test(code) ? code : undefined;
}
