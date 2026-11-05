import { get, type ClientRequest } from 'node:http';

export interface Probed {
  readonly status: number;
  readonly body: string;
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_BODY_BYTES = 1 << 20;

/**
 * A plain GET that follows a few redirects as `fetch` does and answers with what it read, or undefined when the connection fails, the answer is too long or nothing finishes within `timeoutMs` in all.
 * It does not use `fetch`, whose client can throw from a socket event, out of reach of the caller's try and catch, when a connection is reset just after it opens.
 */
function read(url: string, timeoutMs: number, withBody: boolean): Promise<Probed | undefined> {
  return new Promise((resolve) => {
    let finished = false;
    let current: ClientRequest | undefined;
    const deadline = setTimeout(() => finish(undefined), timeoutMs);
    const finish = (answer: Probed | undefined): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      current?.destroy();
      resolve(answer);
    };
    const visit = (target: string, redirectsLeft: number): void => {
      let request: ClientRequest;
      try {
        request = get(target);
      } catch {
        finish(undefined);
        return;
      }
      current = request;
      request.on('error', () => finish(undefined));
      request.on('upgrade', (response, socket) => {
        socket.destroy();
        finish({ status: response.statusCode ?? 0, body: '' });
      });
      request.on('response', (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (REDIRECT_STATUSES.has(status) && location !== undefined) {
          response.resume();
          request.destroy();
          if (redirectsLeft === 0) return finish(undefined);
          try {
            return visit(new URL(location, target).toString(), redirectsLeft - 1);
          } catch {
            return finish(undefined);
          }
        }
        if (!withBody) return finish({ status, body: '' });
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) return finish(undefined);
          chunks.push(chunk);
        });
        response.on('end', () => finish({ status, body: Buffer.concat(chunks).toString() }));
        response.on('error', () => finish(undefined));
        response.on('aborted', () => finish(undefined));
      });
    };
    visit(url, MAX_REDIRECTS);
  });
}

/** The status of the answer to a GET, taken when its headers arrive, whatever the body does. */
export async function probeStatus(url: string, timeoutMs: number): Promise<number | undefined> {
  return (await read(url, timeoutMs, false))?.status;
}

/** The status and the whole body of the answer to a GET, up to a megabyte. */
export function probeBody(url: string, timeoutMs: number): Promise<Probed | undefined> {
  return read(url, timeoutMs, true);
}
