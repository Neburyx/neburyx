import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ModelStub {
  readonly baseUrl: string;
  /** The body of each request it received, in order. */
  readonly requests: string[];
  /** The replies it gives, the next first. */
  readonly replies: string[];
  close(): Promise<void>;
}

/** A stand-in for the model service on the loopback address, as a scripted external provider for the extension's own model client. */
export async function startModelStub(): Promise<ModelStub> {
  const requests: string[] = [];
  const replies: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: replies.shift() ?? '' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the stub has no port');
  return { baseUrl: `http://127.0.0.1:${(address satisfies AddressInfo).port}`, requests, replies, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
