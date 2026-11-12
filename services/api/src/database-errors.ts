const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH']);

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

const CONNECTION_ERROR_MESSAGES = new Set([
  'timeout exceeded when trying to connect',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'Client has encountered a connection error and is not queryable',
]);

export function isConnectionError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === undefined) return error instanceof Error && CONNECTION_ERROR_MESSAGES.has(error.message);
  return CONNECTION_ERROR_CODES.has(code) || ['08', '28', '57'].some((prefix) => code.startsWith(prefix)) || code === '3D000';
}

const LOOKUP_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const CONNECT_LIMIT_MESSAGES = new Set(['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout']);

export type ConnectionCause = 'lookup' | 'limit';

/** Why a connection could not be opened, when the error says: the name did not resolve, or opening it (the lookup included) took longer than the connect limit. */
export function connectionCause(error: unknown): ConnectionCause | undefined {
  const code = errorCode(error);
  if (code !== undefined && LOOKUP_ERROR_CODES.has(code)) return 'lookup';
  return error instanceof Error && CONNECT_LIMIT_MESSAGES.has(error.message) ? 'limit' : undefined;
}

/** What a command says of a failure of the application database that it can name: the database could not be reached, or its schema is behind this version. `undefined` for any other failure. */
export function databaseMessage(error: unknown): string | undefined {
  if (isConnectionError(error)) return 'the database could not be reached\n';
  if (errorCode(error) === '42P01' || errorCode(error) === '42703') return 'the database schema is behind this version; run neburyx migrate\n';
  return undefined;
}
