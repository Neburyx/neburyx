import { appendFileSync } from 'node:fs';
import dns from 'node:dns';

// A preload (`--import`) that makes the lookup of one fake name slow, failing or endless, and counts the lookups in a file.
export const SLOW_HOST = 'slow-db.test';

const delayMs = Number(process.env['NBX_TEST_LOOKUP_DELAY_MS'] ?? '0');
const outcome = process.env['NBX_TEST_LOOKUP_OUTCOME'] ?? 'resolve';
const logFile = process.env['NBX_TEST_LOOKUP_LOG'];
const original = dns.lookup;

dns.lookup = function lookup(hostname, options, callback) {
  if (hostname !== SLOW_HOST) return original.call(dns, hostname, options, callback);
  const done = typeof options === 'function' ? options : callback;
  const settings = typeof options === 'function' ? {} : options;
  if (logFile !== undefined) appendFileSync(logFile, 'lookup\n');
  if (outcome === 'never') return;
  setTimeout(() => {
    if (outcome === 'fail') return done(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname }));
    if (settings.all === true) return done(null, [{ address: '127.0.0.1', family: 4 }]);
    return done(null, '127.0.0.1', 4);
  }, delayMs);
};
