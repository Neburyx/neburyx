import { isIPv4, isIPv6 } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';

const LOOPBACK_IPV4 = /^127\./;
const LOOPBACK_IPV6 = new Set(['[::1]']);
const MAPPED_LOOPBACK_IPV6 = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;
const CONTAINER_FILE = '/.dockerenv';

export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIPv4(host)) return LOOPBACK_IPV4.test(host);
  if (!isIPv6(host)) return false;
  const address = host.split('%')[0] ?? host;
  const normalised = new URL(`http://[${address}]`).hostname;
  return LOOPBACK_IPV6.has(normalised) || MAPPED_LOOPBACK_IPV6.test(normalised);
}

export function isInContainer(
  env: Readonly<Record<string, string | undefined>>,
  fileExists: (path: string) => boolean,
): boolean {
  return env['NEBURYX_CONTAINER'] === 'true' || fileExists(CONTAINER_FILE);
}

export function warnIfExposed(logger: FastifyBaseLogger, host: string, inContainer: boolean): void {
  if (inContainer || isLoopbackHost(host)) return;
  logger.warn(
    { event: 'server.exposed', host },
    'Listening on a non-loopback address outside a container: anyone who can reach this host can use the app, which has no sign-in',
  );
}
