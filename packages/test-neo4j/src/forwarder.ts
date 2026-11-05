import { connect, createServer, type Server, type Socket } from 'node:net';
import { registerOpen } from './registry.js';

export interface Forwarder {
  /** The address of the forwarder, on the loopback interface, as a plain `bolt://` (or `bolt+ssc://`) address. */
  readonly uri: string;
  /** Closes the port and drops every connection: a connection attempt is refused, as at a stopped server. */
  stop(): Promise<void>;
  /** Opens the same port again. */
  resume(): Promise<void>;
  close(): Promise<void>;
}

const SCHEMES: Readonly<Record<string, string>> = { 'bolt:': 'bolt:', 'neo4j:': 'bolt:', 'bolt+ssc:': 'bolt+ssc:', 'neo4j+ssc:': 'bolt+ssc:' };

/**
 * Forwards a loopback port to an address, so that a test can stop and bring back what answers there, or reach it by a loopback address. A driver that is given a
 * routing address would go to the servers the first one advertises and not through the forwarder, and a certificate-checked connection would be checked against the
 * loopback address, so a routing scheme is read as the direct one of the same server, and `+s` addresses are refused.
 */
export async function forwardTo(address: string): Promise<Forwarder> {
  let target: URL;
  try {
    target = new URL(address);
  } catch {
    // the error of a malformed URL holds the text it was given
    throw new Error('the forwarder was given an address that is not a URL');
  }
  const scheme = SCHEMES[target.protocol];
  if (scheme === undefined) throw new Error(`the forwarder takes bolt, neo4j, bolt+ssc and neo4j+ssc addresses, not ${target.protocol}`);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port === '' ? 7687 : target.port);
  const sockets = new Set<Socket>();
  let listener: Server | undefined;

  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  };
  const listen = (bound: number): Promise<Server> =>
    new Promise((resolve, reject) => {
      const created = createServer((client) => {
        track(client);
        const upstream = connect(port, host);
        track(upstream);
        // whichever side ends or fails takes the other with it, so that nothing is left hanging
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
        client.pipe(upstream);
        upstream.pipe(client);
      });
      created.once('error', reject);
      created.listen(bound, '127.0.0.1', () => resolve(created));
    });
  const closeListener = async (): Promise<void> => {
    const closing = listener;
    listener = undefined;
    for (const socket of sockets) socket.destroy();
    if (closing !== undefined) await new Promise<void>((resolve) => closing.close(() => resolve()));
  };

  listener = await listen(0);
  const bound = listener.address();
  if (bound === null || typeof bound === 'string') throw new Error('the forwarder has no port');
  const local = bound.port;
  const forget = registerOpen(closeListener);
  return {
    uri: `${scheme}//127.0.0.1:${local}`,
    stop: closeListener,
    async resume() {
      listener ??= await listen(local);
    },
    async close() {
      await closeListener();
      forget();
    },
  };
}
