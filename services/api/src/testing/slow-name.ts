import dns from 'node:dns';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRELOAD = fileURLToPath(new URL('./slow-lookup.mjs', import.meta.url));

export const SLOW_NAME = 'slow-db.test';

export interface SlowName {
  /** The URL with its host replaced by the slow name. */
  readonly urlFor: (url: string) => string;
  /** The environment that loads the delayed resolver into a child process. */
  readonly env: Readonly<Record<string, string>>;
  /** How many times the resolver was asked for the name. */
  readonly lookups: () => number;
  readonly remove: () => void;
}

export function slowName(outcome: 'resolve' | 'fail' | 'never', delayMs: number): SlowName {
  const folder = mkdtempSync(join(tmpdir(), 'neburyx-lookup-'));
  const log = join(folder, 'lookups');
  writeFileSync(log, '');
  return {
    urlFor: (url) => {
      const slow = new URL(url);
      slow.hostname = SLOW_NAME;
      return slow.toString();
    },
    env: { NODE_OPTIONS: `--import=${PRELOAD}`, NBX_TEST_LOOKUP_DELAY_MS: String(delayMs), NBX_TEST_LOOKUP_OUTCOME: outcome, NBX_TEST_LOOKUP_LOG: log },
    lookups: () => readFileSync(log, 'utf8').split('\n').filter((line) => line === 'lookup').length,
    remove: () => rmSync(folder, { recursive: true, force: true }),
  };
}

export interface SlowLookup {
  readonly lookups: () => number;
  readonly restore: () => void;
}

/** The same delayed resolver for code that runs in this process: `dns.lookup` answers for the slow name after `delayMs`, or never. */
export function slowLookupInProcess(outcome: 'resolve' | 'fail' | 'never', delayMs: number): SlowLookup {
  const original = dns.lookup;
  let asked = 0;
  // the overloads of `dns.lookup` cannot be matched by a plain function; the fake serves the two shapes the address cache uses
  const fake = (hostname: string, options: dns.LookupOptions, callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void): void => {
    if (hostname !== SLOW_NAME) return Reflect.apply(original, dns, [hostname, options, callback]);
    asked += 1;
    if (outcome === 'never') return;
    setTimeout(() => (outcome === 'fail' ? callback(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), []) : callback(null, [{ address: '127.0.0.1', family: 4 }])), delayMs);
  };
  Object.defineProperty(dns, 'lookup', { value: fake, configurable: true, writable: true });
  return {
    lookups: () => asked,
    restore: () => Object.defineProperty(dns, 'lookup', { value: original, configurable: true, writable: true }),
  };
}
