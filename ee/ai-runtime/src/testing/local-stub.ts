import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type LocalReply = (response: ServerResponse) => void;

export const json = (status: number, body: unknown): LocalReply => (response) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

export const completion = (extra: Record<string, unknown> = {}, message: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'local-model',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'A synthetic answer.', ...message } }],
  usage: { prompt_tokens: 12, completion_tokens: 34 },
  ...extra,
});

export interface LocalStub {
  readonly baseUrl: string;
  readonly bodies: string[];
  readonly headers: Record<string, string | string[] | undefined>[];
  reply: LocalReply;
  close: () => Promise<void>;
}

export async function startLocalStub(): Promise<LocalStub> {
  const sockets = new Set<Socket>();
  const stub: LocalStub = { baseUrl: '', bodies: [], headers: [], reply: json(200, completion()), close: () => Promise.resolve() };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      stub.bodies.push(Buffer.concat(chunks).toString('utf8'));
      stub.headers.push(request.headers);
      stub.reply(response);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(stub, {
    baseUrl,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}
