import { connect, createServer, type Server, type Socket } from 'node:net';

export interface Forwarder {
  readonly url: string;
  stop(): Promise<void>;
  stall(): Promise<void>;
  muteReplies(): void;
  resume(): Promise<void>;
}

type Mode = 'forwarding' | 'stalled' | 'muted' | 'stopped';

export async function forwardTo(databaseUrl: string): Promise<Forwarder> {
  const target = new URL(databaseUrl);
  const sockets = new Set<Socket>();
  let mode: Mode = 'forwarding';
  let server: Server | undefined;

  function track(socket: Socket): void {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  }

  function listen(port: number): Promise<Server> {
    const listener = createServer((client) => {
      track(client);
      if (mode === 'stalled') return;
      const upstream = connect(Number(target.port), target.hostname);
      track(upstream);
      client.pipe(upstream);
      upstream.on('data', (chunk: Buffer) => {
        if (mode !== 'muted') client.write(chunk);
      });
      upstream.on('end', () => client.end());
    });
    return new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(port, '127.0.0.1', () => resolve(listener));
    });
  }

  function dropConnections(): void {
    for (const socket of sockets) socket.destroy();
  }

  async function closeListener(): Promise<void> {
    const closing = server;
    server = undefined;
    dropConnections();
    if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
  }

  server = await listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the forwarder has no port');
  const port = address.port;
  const url = new URL(databaseUrl);
  url.hostname = '127.0.0.1';
  url.port = String(port);

  return {
    url: url.toString(),
    async stop(): Promise<void> {
      mode = 'stopped';
      await closeListener();
    },
    async stall(): Promise<void> {
      dropConnections();
      mode = 'stalled';
      server ??= await listen(port);
    },
    muteReplies(): void {
      mode = 'muted';
    },
    async resume(): Promise<void> {
      dropConnections();
      mode = 'forwarding';
      server ??= await listen(port);
    },
  };
}
