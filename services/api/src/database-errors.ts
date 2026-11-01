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
