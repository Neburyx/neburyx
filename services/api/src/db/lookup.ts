import dns from 'node:dns';
import net from 'node:net';

/**
 * How long an answer is used before a fresh lookup starts in the background. A hypothesis: no source gives
 * a figure; a macOS `.local` name was measured at 5.0 s per lookup, so a lookup must never sit in front of a connection.
 */
export const ADDRESS_LIFETIME_MS = 60_000;

export type Resolve = (hostname: string, options: dns.LookupOptions) => Promise<readonly dns.LookupAddress[]>;

export interface AddressCache {
  readonly lookup: net.LookupFunction;
}

export interface AddressCacheOptions {
  readonly resolve?: Resolve;
  readonly now?: () => number;
  readonly lifetimeMs?: number;
}

interface Entry {
  addresses: readonly dns.LookupAddress[];
  fetchedAt: number;
}

const systemResolve: Resolve = (hostname, options) =>
  new Promise((resolve, reject) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => (error === null ? resolve(addresses) : reject(error)));
  });

/** Remembers the answer for a name so that every connection of a process does not pay its own lookup. */
export function createAddressCache(options: AddressCacheOptions = {}): AddressCache {
  const resolve = options.resolve ?? systemResolve;
  const now = options.now ?? Date.now;
  const lifetimeMs = options.lifetimeMs ?? ADDRESS_LIFETIME_MS;
  const entries = new Map<string, Entry>();
  const running = new Map<string, Promise<readonly dns.LookupAddress[]>>();

  function load(key: string, hostname: string, lookupOptions: dns.LookupOptions): Promise<readonly dns.LookupAddress[]> {
    const existing = running.get(key);
    if (existing !== undefined) return existing;
    const started = resolve(hostname, lookupOptions).then(
      (addresses) => {
        entries.set(key, { addresses, fetchedAt: now() });
        return addresses;
      },
      (error: unknown) => {
        const old = entries.get(key);
        // a failed refresh keeps the old answer and waits a lifetime before the next try
        if (old !== undefined) old.fetchedAt = now();
        throw error;
      },
    );
    const finished = started.finally(() => running.delete(key));
    running.set(key, finished);
    return finished;
  }

  const lookup: net.LookupFunction = (hostname, lookupOptions, callback) => {
    const key = `${hostname}|${String(lookupOptions.family ?? 0)}`;
    const answer = (addresses: readonly dns.LookupAddress[]): void => {
      const first = addresses[0];
      if (first === undefined) callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '');
      else if (lookupOptions.all === true) callback(null, [...addresses]);
      else callback(null, first.address, first.family);
    };
    const entry = entries.get(key);
    if (entry === undefined) {
      load(key, hostname, lookupOptions).then(answer, (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), ''));
      return;
    }
    if (now() - entry.fetchedAt >= lifetimeMs) load(key, hostname, lookupOptions).catch(() => undefined);
    // `dns.lookup` never answers before it returns, and a socket relies on that
    process.nextTick(answer, entry.addresses);
  };

  return { lookup };
}

class LookupSocket extends net.Socket {
  constructor(private readonly lookup: net.LookupFunction) {
    super();
  }

  override connect(options: net.SocketConnectOpts, listener?: () => void): this;
  override connect(port: number, host: string, listener?: () => void): this;
  override connect(port: number, listener?: () => void): this;
  override connect(path: string, listener?: () => void): this;
  override connect(first: net.SocketConnectOpts | number | string, second?: string | (() => void), third?: () => void): this {
    if (typeof first === 'number' && typeof second === 'string') return super.connect({ port: first, host: second, lookup: this.lookup }, third);
    const listener = typeof second === 'function' ? second : undefined;
    if (typeof first === 'number') return super.connect(first, listener);
    if (typeof first === 'string') return super.connect(first, listener);
    return super.connect(first, listener);
  }
}

/** The `stream` option of a `pg` client: a socket that connects by name and takes the address from the cache, so the name still reaches TLS. */
export function lookupStream(cache: AddressCache): () => net.Socket {
  return () => new LookupSocket(cache.lookup);
}
