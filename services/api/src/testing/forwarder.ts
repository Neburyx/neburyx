import { connect, createServer, type Server, type Socket } from 'node:net';

export interface Forwarder {
  readonly url: string;
  stop(): Promise<void>;
}

export async function forwardTo(databaseUrl: string): Promise<Forwarder> {
  const target = new URL(databaseUrl);
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the forwarder has no port');
  const url = new URL(databaseUrl);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);

  return {
    url: url.toString(),
    async stop(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
