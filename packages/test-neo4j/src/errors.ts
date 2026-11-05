/** The code of a server error, kept only when it has the shape of one (`Neo.ClientError.Schema.Something`); anything else, such as a code a driver took from an address, is not kept. */
const SERVER_CODE = /^Neo\.[A-Za-z]+\.[A-Za-z]+\.[A-Za-z]+$/;

function codeOf(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown';
  return SERVER_CODE.test(code) ? code : 'unknown';
}

export interface StartFailure extends Error {
  readonly code: string;
  /** Whether the server said the thing already existed; read from the server's message, which is then dropped. */
  readonly alreadyExists: boolean;
}

/** Says what failed with the server's code and nothing else: the message of the driver or the server can carry the address, and a name or a password. */
export function failure(what: string, error: unknown): StartFailure {
  const code = codeOf(error);
  const alreadyExists = (error instanceof Error && /already exists/i.test(error.message)) || (error as { alreadyExists?: unknown } | null)?.alreadyExists === true;
  return Object.assign(new Error(`${what} (${code})`), { code, alreadyExists });
}
