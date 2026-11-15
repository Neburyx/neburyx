import { createServer, type Server } from 'node:net';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { testPool } from './database.js';

const message = (type: string, body: Buffer): Buffer => {
  const framed = Buffer.alloc(5 + body.length);
  framed.write(type, 0);
  framed.writeInt32BE(4 + body.length, 1);
  body.copy(framed, 5);
  return framed;
};
const field = (code: string, text: string): Buffer => Buffer.from(`${code}${text}\0`);
const SHUTDOWN = message('E', Buffer.concat([field('S', 'FATAL'), field('V', 'FATAL'), field('C', '57P01'), field('M', 'terminating connection due to administrator command'), Buffer.from('\0')]));

/** A server that logs a client in and, when the client says it is closing, answers with the notice Postgres sends while it stops, so the notice reaches a client that is closing. */
async function stoppingServer(): Promise<{ readonly url: string; readonly server: Server }> {
  const server = createServer((socket) => {
    let loggedIn = false;
    socket.on('data', (data) => {
      if (!loggedIn) {
        loggedIn = true;
        socket.write(Buffer.concat([message('R', Buffer.alloc(4)), message('Z', Buffer.from('I'))]));
      } else if (data[0] === 0x58) {
        socket.write(SHUTDOWN);
        setTimeout(() => socket.end(), 30);
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { url: `postgres://user:password@127.0.0.1:${address.port}/database?sslmode=disable`, server };
}

/** Runs one connection through the pool and its end, until the pool has removed the client (its socket closed, after the notice), and says how many listeners the pool had for each `error` it was given when `count` is set; an unhandled one then does not throw. */
async function endAgainstStoppingServer(make: (url: string) => pg.Pool, count: boolean): Promise<number[]> {
  const { url, server } = await stoppingServer();
  const pool = make(url);
  const seen: number[] = [];
  const emit = pool.emit.bind(pool);
  if (count) {
    pool.emit = ((event: string, ...rest: unknown[]) => {
      if (event !== 'error') return emit(event, ...rest);
      seen.push(pool.listenerCount('error'));
      return true;
    }) as typeof pool.emit;
  }
  (await pool.connect()).release();
  // `events.once` would add a listener for `error` of its own, which is the thing measured
  const removed = new Promise<void>((resolve) => pool.once('remove', () => resolve()));
  await pool.end();
  await removed;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return seen;
}

describe('the pool a test reads the database with', () => {
  it('lets the shutdown notice that reaches a client after the pool has ended pass, with the real emit and no error in the run', async () => {
    await endAgainstStoppingServer(testPool, false);
  });

  it('still throws an error that reaches the pool before it has ended', () => {
    const pool = testPool('postgres://user:password@127.0.0.1:1/database');
    expect(() => pool.emit('error', new Error('a connection failed'))).toThrow('a connection failed');
  });

  it('is needed: a plain pool receives the same notice with no listener, which throws in the run', async () => {
    expect(await endAgainstStoppingServer((url) => new pg.Pool({ connectionString: url }), true)).toEqual([0]);
  });
});
