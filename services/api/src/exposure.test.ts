import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { isInContainer, isLoopbackHost, warnIfExposed } from './exposure.js';

function warnings(host: string, inContainer: boolean): readonly Record<string, unknown>[] {
  const lines: string[] = [];
  const logger = pino({ level: 'info' }, { write: (chunk: string) => lines.push(chunk) });
  warnIfExposed(logger, host, inContainer);
  return lines.map((line) => JSON.parse(line));
}

describe('warnIfExposed', () => {
  it.each(['0.0.0.0', '::', '192.168.1.20', 'api.example.test'])('warns once for %s outside a container', (host) => {
    const lines = warnings(host, false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 40, event: 'server.exposed', host });
  });

  it.each(['127.0.0.1', '127.0.0.5', '::1', 'localhost'])('stays silent for %s outside a container', (host) => {
    expect(warnings(host, false)).toEqual([]);
  });

  it.each(['0.0.0.0', '::', '192.168.1.20', 'api.example.test', '127.0.0.1'])('stays silent for %s in a container', (host) => {
    expect(warnings(host, true)).toEqual([]);
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.255.255.254', '::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '::ffff:127.0.0.1', 'localhost'])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '::2', '128.0.0.1', '127.0.0', '127.0.0.999', '1270.0.0.1', 'localhost.example.test'])('rejects %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('a scoped IPv6 address', () => {
  it('is not loopback and does not throw', () => {
    expect(isLoopbackHost('fe80::1%lo0')).toBe(false);
  });

  it('is classified by its address, so a scoped loopback is still loopback', () => {
    expect(isLoopbackHost('::1%lo0')).toBe(true);
  });

  it('warns once outside a container', () => {
    expect(warnings('fe80::1%lo0', false)).toHaveLength(1);
  });
});

describe('isInContainer', () => {
  it('is true when the image sets NEBURYX_CONTAINER=true', () => {
    expect(isInContainer({ NEBURYX_CONTAINER: 'true' }, () => false)).toBe(true);
  });

  it('is true when /.dockerenv exists', () => {
    expect(isInContainer({}, (path) => path === '/.dockerenv')).toBe(true);
  });

  it.each([{}, { NEBURYX_CONTAINER: 'false' }, { NEBURYX_CONTAINER: '1' }])('is false otherwise (%j)', (env) => {
    expect(isInContainer(env, () => false)).toBe(false);
  });
});
