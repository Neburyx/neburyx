import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A stand-in for the model service on the loopback address: it records the body of each request and answers the next reply a case gave it (no intent when none is left). */
export interface ModelStub {
  readonly baseUrl: string;
  /** The body of each request it received, in order. */
  readonly requests: string[];
  /** The replies it will give, the next first. */
  readonly replies: string[];
  reset(): void;
  close(): Promise<void>;
}

const NO_INTENT_REPLY = '{"intent":null,"entities":{}}';

/** `fallback` answers a request from its body when no reply is queued: a model that keeps asking for another read, whatever it is asked. */
export async function startModelStub(fallback?: (body: string) => string): Promise<ModelStub> {
  const requests: string[] = [];
  const replies: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: replies.shift() ?? fallback?.(body) ?? NO_INTENT_REPLY }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    requests,
    replies,
    reset: () => {
      requests.length = 0;
      replies.length = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
