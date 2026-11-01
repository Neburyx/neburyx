import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_HOST, DEFAULT_PORT, parseConfig } from './config.js';

const defaults = { webRoot: '/default/web' };
const DATABASE_URL = 'postgres://app_user:app-secret@db.example.test:5432/neburyx';
const database = { DATABASE_URL };

describe('parseConfig', () => {
  it.each(['0', '65536', 'abc', '8080x', '-1', '', '80.5'])('rejects the port %j naming only the key', (port) => {
    const failure = (): unknown => parseConfig({ ...database, NEBURYX_PORT: port }, defaults);
    expect(failure).toThrow(ConfigError);
    expect(failure).toThrow('NEBURYX_PORT');
    if (port.length > 0) expect(failure).not.toThrow(port);
  });

  it.each(['', 'bad host', 'a..b', '-x.example', 'host_name', '999.1.1.1', '1.2.3', 'http://localhost', '::g'])(
    'rejects the host %j naming only the key',
    (host) => {
      const failure = (): unknown => parseConfig({ ...database, NEBURYX_HOST: host }, defaults);
      expect(failure).toThrow('NEBURYX_HOST');
      if (host.length > 0) expect(failure).not.toThrow(host);
    },
  );

  it.each(['localhost', 'api.example.test', '0.0.0.0', '127.0.0.1', '192.168.1.20', '::', '::1', '0:0:0:0:0:0:0:1'])(
    'accepts the host %j',
    (host) => {
      expect(parseConfig({ ...database, NEBURYX_HOST: host }, defaults).host).toBe(host);
    },
  );

  it('reports every invalid key once', () => {
    expect(() => parseConfig({ DATABASE_URL: 'x', NEBURYX_HOST: '', NEBURYX_PORT: 'x', NEBURYX_WEB_ROOT: '' }, defaults)).toThrow(
      'invalid configuration: NEBURYX_HOST, NEBURYX_PORT, NEBURYX_WEB_ROOT, DATABASE_URL',
    );
  });

  it('leaves the mapping path unset by default and resolves it when set', () => {
    expect(parseConfig({ ...database }, defaults).mappingPath).toBeUndefined();
    expect(parseConfig({ ...database, NEBURYX_CONFIG: 'conf/neburyx.yaml' }, defaults).mappingPath).toBe(resolve('conf/neburyx.yaml'));
  });

  it('rejects an empty mapping path naming only the key', () => {
    expect(() => parseConfig({ ...database, NEBURYX_CONFIG: '' }, defaults)).toThrow('NEBURYX_CONFIG');
  });

  it('defaults to the loopback address and port 8080', () => {
    expect(parseConfig({ ...database }, defaults)).toEqual({ host: '127.0.0.1', port: 8080, webRoot: '/default/web', databaseUrl: DATABASE_URL });
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PORT).toBe(8080);
  });

  it('takes the values from the environment', () => {
    expect(parseConfig({ ...database, NEBURYX_HOST: '0.0.0.0', NEBURYX_PORT: '9000', NEBURYX_WEB_ROOT: '/srv/web' }, defaults)).toEqual({
      host: '0.0.0.0',
      port: 9000,
      webRoot: '/srv/web',
      databaseUrl: DATABASE_URL,
    });
  });

  it('resolves a relative web folder against the working directory', () => {
    expect(parseConfig({ ...database, NEBURYX_WEB_ROOT: 'apps/web/dist' }, defaults).webRoot).toBe(resolve('apps/web/dist'));
  });

  it.each([undefined, '', 'not a url', 'mysql://app@db.example.test/neburyx', 'db.example.test:5432', 'postgres://app:%FF@db.example.test/neburyx', 'postgres://%FF/neburyx'])(
    'rejects DATABASE_URL %j naming only the key',
    (value) => {
      const failure = (): unknown => parseConfig({ DATABASE_URL: value }, defaults);
      expect(failure).toThrow(ConfigError);
      expect(failure).toThrow('invalid configuration: DATABASE_URL');
      if (value) expect(failure).not.toThrow(value);
    },
  );

  it.each(['postgres://app@db.example.test/neburyx', 'postgresql://app:secret@localhost:5432/neburyx?sslmode=require', 'postgres://app:pw@db.example.test/neburyx?application_name=p%25word'])(
    'accepts the DATABASE_URL %j',
    (value) => {
      expect(parseConfig({ DATABASE_URL: value }, defaults).databaseUrl).toBe(value);
    },
  );
});
