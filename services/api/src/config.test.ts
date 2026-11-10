import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_EXPORT_DIRECTORY, DEFAULT_HOST, DEFAULT_PORT, parseConfig } from './config.js';

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
    expect(parseConfig({ ...database }, defaults)).toMatchObject({ host: '127.0.0.1', port: 8080, webRoot: '/default/web', databaseUrl: DATABASE_URL });
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PORT).toBe(8080);
  });

  it('takes the values from the environment', () => {
    expect(parseConfig({ ...database, NEBURYX_HOST: '0.0.0.0', NEBURYX_PORT: '9000', NEBURYX_WEB_ROOT: '/srv/web' }, defaults)).toEqual({
      host: '0.0.0.0',
      port: 9000,
      webRoot: '/srv/web',
      databaseUrl: DATABASE_URL,
      exportDirectory: DEFAULT_EXPORT_DIRECTORY,
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

describe('the cursor key', () => {
  const key = Buffer.alloc(32, 5).toString('base64');

  it('is absent by default', () => {
    expect(parseConfig({ ...database }, defaults).cursorKey).toBeUndefined();
  });

  it.each([
    ['32 bytes in base64', key],
    ['32 bytes in base64 without padding', key.replace(/=+$/, '')],
    ['64 bytes', Buffer.alloc(64, 6).toString('base64')],
  ])('is accepted as %s, and held as bytes', (_name, value) => {
    const parsed = parseConfig({ ...database, NEBURYX_CURSOR_KEY: value }, defaults).cursorKey;
    expect(Buffer.isBuffer(parsed)).toBe(true);
    expect((parsed?.length ?? 0) >= 32).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['31 bytes', Buffer.alloc(31, 5).toString('base64')],
    ['text that is not base64', 'this is not base64 at all, it has spaces and is long enough!'],
    ['the url alphabet', Buffer.from([251, 255, 254, ...Array.from({ length: 29 }, () => 250)]).toString('base64url')],
    ['hex that is too short', '00'.repeat(16)],
    ['padding in the middle', `${key}=${key}`],
    ['a second spelling of the last character', key.slice(0, -2) + 'B='],
    ['32 bytes with one padding character too many', `${key}=`],
    ['33 bytes with padding added that the text does not need', `${Buffer.alloc(33, 5).toString('base64')}==`],
    ['padding where the bytes need none', `${Buffer.alloc(33, 5).toString('base64')}=`],
    ['too much padding for the bytes', `${Buffer.alloc(34, 5).toString('base64')}=`],
  ])('is refused when it is %s, naming only the variable and never the value', (_name, value) => {
    const failure = (): unknown => parseConfig({ ...database, NEBURYX_CURSOR_KEY: value }, defaults);
    expect(failure).toThrow(ConfigError);
    expect(failure).toThrow('invalid configuration: NEBURYX_CURSOR_KEY');
    try {
      failure();
    } catch (error) {
      expect((error as Error).message).toBe('invalid configuration: NEBURYX_CURSOR_KEY');
      if (value.length > 0) expect(JSON.stringify([error, String(error)])).not.toContain(value);
    }
  });

  it('keeps export files in /data/exports unless told otherwise', () => {
    expect(parseConfig({ ...database }, defaults).exportDirectory).toBe(DEFAULT_EXPORT_DIRECTORY);
    expect(parseConfig({ ...database, NEBURYX_EXPORT_DIR: '/srv/exports' }, defaults).exportDirectory).toBe('/srv/exports');
  });

  it.each(['', 'exports', './exports', '../exports'])('rejects the export directory %j, naming only the key', (directory) => {
    const failure = (): unknown => parseConfig({ ...database, NEBURYX_EXPORT_DIR: directory }, defaults);
    expect(failure).toThrow(ConfigError);
    expect(failure).toThrow('NEBURYX_EXPORT_DIR');
    if (directory.length > 0) expect(failure).not.toThrow(directory);
  });
});
