import { connect } from 'node:net';
import type { FastifyInstance } from 'fastify';

export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly text: string;
}

export function portOf(app: FastifyInstance): number {
  const address = app.server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

export function parseRawResponse(text: string): RawResponse {
  const [head = '', ...rest] = text.split('\r\n\r\n');
  const [statusLine = '', ...headerLines] = head.split('\r\n');
  const headers = Object.fromEntries(
    headerLines.map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }),
  );
  return { status: Number(statusLine.split(' ')[1]), headers, body: rest.join('\r\n\r\n'), text };
}

export async function sendRaw(app: FastifyInstance, request: string): Promise<RawResponse> {
  const socket = connect(portOf(app), '127.0.0.1');
  const received: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => received.push(chunk));
  const closed = new Promise<void>((done) => socket.on('close', () => done()));
  socket.write(request);
  await closed;
  return parseRawResponse(Buffer.concat(received).toString('utf8'));
}
