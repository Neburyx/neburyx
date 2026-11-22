import type { ApiClient } from './client.js';

/** A client that tells `log` the name and the arguments of every method called on it, then calls the method of `base`. */
export function recordingClient(base: ApiClient, log: (name: string, args: readonly unknown[]) => void): ApiClient {
  const wrapped = Object.fromEntries(Object.entries(base).map(([name, method]) => [name, typeof method === 'function' ? (...args: unknown[]): unknown => (log(name, args), method(...args)) : method]));
  // a mapped copy of the client has the same methods, but the compiler cannot see that through the entries
  return wrapped as ApiClient;
}
