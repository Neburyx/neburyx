import type { LookupAddress } from 'node:dns';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { createAddressCache, lookupStream, type Resolve } from './lookup.js';

const LIFETIME = 1000;
const V4: LookupAddress = { address: '127.0.0.1', family: 4 };
const V6: LookupAddress = { address: '::1', family: 6 };

function rig(answers: readonly (readonly LookupAddress[] | Error)[]): { readonly resolve: Resolve; readonly asked: () => number } {
  let asked = 0;
  return {
    resolve: () => {
      const answer = answers[Math.min(asked, answers.length - 1)] ?? [];
      asked += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    asked: () => asked,
  };
}

function ask(cache: ReturnType<typeof createAddressCache>, options: { all?: boolean } = {}): Promise<unknown> {
  return new Promise((resolve, reject) => cache.lookup('db.test', options, (error, address, family) => (error === null ? resolve(options.all === true ? address : [address, family]) : reject(error))));
}

describe('createAddressCache', () => {
  it('asks the resolver once for many lookups of one name, also when they overlap', async () => {
    const fake = rig([[V4]]);
    const cache = createAddressCache({ resolve: fake.resolve, lifetimeMs: LIFETIME });
    await Promise.all([ask(cache), ask(cache), ask(cache)]);
    await ask(cache);
    expect(fake.asked()).toBe(1);
  });

  it('answers every address of both families when asked for all of them', async () => {
    const cache = createAddressCache({ resolve: rig([[V6, V4]]).resolve });
    expect(await ask(cache, { all: true })).toEqual([V6, V4]);
  });

  it('answers the first address with its family when not asked for all of them', async () => {
    const cache = createAddressCache({ resolve: rig([[V4, V6]]).resolve });
    expect(await ask(cache)).toEqual(['127.0.0.1', 4]);
  });

  it('uses the old answer at once after the lifetime and asks again once in the background', async () => {
    let clock = 0;
    const fake = rig([[V4], [V6]]);
    const cache = createAddressCache({ resolve: fake.resolve, now: () => clock, lifetimeMs: LIFETIME });
    await ask(cache);
    clock = LIFETIME + 1;
    expect(await ask(cache)).toEqual(['127.0.0.1', 4]);
    await Promise.resolve();
    expect(fake.asked()).toBe(2);
    expect(await ask(cache)).toEqual(['::1', 6]);
    expect(fake.asked()).toBe(2);
  });

  it('keeps the old answer when a refresh fails and waits a lifetime before trying again', async () => {
    let clock = 0;
    const fake = rig([[V4], new Error('lookup failed')]);
    const cache = createAddressCache({ resolve: fake.resolve, now: () => clock, lifetimeMs: LIFETIME });
    await ask(cache);
    clock = LIFETIME + 1;
    await ask(cache);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await ask(cache)).toEqual(['127.0.0.1', 4]);
    expect(fake.asked()).toBe(2);
  });

  it('passes a failed first lookup to the caller and does not remember it', async () => {
    const failure = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    const fake = rig([failure, [V4]]);
    const cache = createAddressCache({ resolve: fake.resolve });
    await expect(ask(cache)).rejects.toBe(failure);
    expect(await ask(cache)).toEqual(['127.0.0.1', 4]);
  });
});

describe('the answer of the cache', () => {
  it('never comes before the lookup call returns, also when it is already known', async () => {
    const cache = createAddressCache({ resolve: rig([[V4]]).resolve });
    await ask(cache);
    const order: string[] = [];
    const answered = new Promise<void>((resolve) => cache.lookup('db.test', {}, () => (order.push('answered'), resolve())));
    order.push('returned');
    await answered;
    expect(order).toEqual(['returned', 'answered']);
  });

  it('is a lookup error, not an empty result, when the resolver finds no address', async () => {
    const cache = createAddressCache({ resolve: rig([[]]).resolve });
    await expect(ask(cache)).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });
});

describe('lookupStream', () => {
  it('connects by name through the cache, keeping the name for the caller', async () => {
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const asked: string[] = [];
    const cache = createAddressCache({
      resolve: (hostname) => {
        asked.push(hostname);
        return Promise.resolve([V4]);
      },
    });
    const socket = lookupStream(cache)();
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
      socket.connect(address.port, 'db.test');
    });
    expect(asked).toEqual(['db.test']);
    socket.destroy();
    server.close();
  });

  it('connects to a socket path as given, without a lookup', async () => {
    const asked: string[] = [];
    const cache = createAddressCache({
      resolve: (hostname) => {
        asked.push(hostname);
        return Promise.resolve([V4]);
      },
    });
    const socket = lookupStream(cache)();
    await new Promise<void>((resolve) => {
      socket.once('error', () => resolve());
      socket.connect('/nonexistent/neburyx-socket');
    });
    expect(asked).toEqual([]);
    socket.destroy();
  });
});
