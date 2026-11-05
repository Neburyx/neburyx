import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DevNeo4jNotConfigured, devSettings, fastSettings, parseEnvFile } from './settings.js';

const folders: string[] = [];
const fileWith = (text: string): string => {
  const folder = mkdtempSync(join(tmpdir(), 'dev-neo4j-'));
  folders.push(folder);
  const file = join(folder, 'dev-neo4j.env');
  writeFileSync(file, text);
  return file;
};
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const GIVEN = { NBX_EE_URI: 'bolt://dev.example.test:7687', NBX_EE_USER: 'someone', NBX_EE_PASSWORD: 'secret-value' };

describe('the settings of the dev Neo4j server', () => {
  it('reads the three variables from the environment', () => {
    expect(devSettings(GIVEN, '/nonexistent/file')).toEqual({ uri: GIVEN.NBX_EE_URI, user: GIVEN.NBX_EE_USER, password: GIVEN.NBX_EE_PASSWORD });
  });

  it('reads them from the file when the environment does not have them, with export, quotes and comments', () => {
    const file = fileWith(`# the dev server\nexport NBX_EE_URI="${GIVEN.NBX_EE_URI}"\nNBX_EE_USER='${GIVEN.NBX_EE_USER}'\n\nNBX_EE_PASSWORD=${GIVEN.NBX_EE_PASSWORD}\n`);
    expect(devSettings({}, file)).toEqual({ uri: GIVEN.NBX_EE_URI, user: GIVEN.NBX_EE_USER, password: GIVEN.NBX_EE_PASSWORD });
  });

  it('lets a variable of the environment win over the file', () => {
    const file = fileWith(`NBX_EE_URI=bolt://other.example.test\nNBX_EE_USER=other\nNBX_EE_PASSWORD=other-password\n`);
    expect(devSettings({ NBX_EE_USER: 'mine' }, file).user).toBe('mine');
  });

  it('fails loudly and names what is missing, without a value, when neither the environment nor the file gives it', () => {
    const file = fileWith('NBX_EE_URI=bolt://dev.example.test:7687\n');
    try {
      devSettings({}, file);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DevNeo4jNotConfigured);
      expect((error as DevNeo4jNotConfigured).missing).toEqual(['NBX_EE_USER', 'NBX_EE_PASSWORD']);
      expect((error as Error).message).not.toContain('dev.example.test');
    }
    expect(() => devSettings({}, '/nonexistent/file')).toThrow(/NBX_EE_URI, NBX_EE_USER, NBX_EE_PASSWORD/);
  });

  it('refuses a login whose name has the prefix of what the tests clean up, and an address that is not a bolt address', () => {
    expect(() => devSettings({ ...GIVEN, NBX_EE_USER: 'nbx_test_x_reader' }, '/nonexistent/file')).toThrow(/starts with nbx_test_/);
    expect(() => devSettings({ ...GIVEN, NBX_EE_URI: 'http://dev.example.test' }, '/nonexistent/file')).toThrow(/not a bolt or neo4j address/);
  });

  it('parses names and values and ignores what is not an assignment', () => {
    expect(parseEnvFile('A=1\n# B=2\nnot an assignment\nexport C = "three"\n')).toEqual({ A: '1', C: 'three' });
  });
});

describe('the settings with the fast address', () => {
  const given = { uri: 'bolt://dev.local:7687', user: 'someone', password: 'secret-value' };

  it('puts the IPv4 address of a plain host in the address and keeps the rest', async () => {
    expect(await fastSettings(given, async () => '192.0.2.7')).toEqual({ ...given, uri: 'bolt://192.0.2.7:7687' });
    expect((await fastSettings({ ...given, uri: 'neo4j://dev.local' }, async () => '192.0.2.7')).uri).toBe('neo4j://192.0.2.7');
  });

  it('leaves an address with a certificate, a host that is an address, and a host that does not resolve as they are, and does not even look the first two up', async () => {
    const looked: string[] = [];
    const finds = async (host: string): Promise<string> => {
      looked.push(host);
      return '192.0.2.7';
    };
    expect(await fastSettings({ ...given, uri: 'bolt+s://dev.local:7687' }, finds)).toEqual({ ...given, uri: 'bolt+s://dev.local:7687' });
    expect(await fastSettings({ ...given, uri: 'neo4j+s://dev.local' }, finds)).toEqual({ ...given, uri: 'neo4j+s://dev.local' });
    expect(await fastSettings({ ...given, uri: 'bolt://192.0.2.1:7687' }, finds)).toEqual({ ...given, uri: 'bolt://192.0.2.1:7687' });
    expect(await fastSettings({ ...given, uri: 'bolt://[::1]:7687' }, finds)).toEqual({ ...given, uri: 'bolt://[::1]:7687' });
    expect(looked).toEqual([]);
    const fails = async (): Promise<string> => {
      throw new Error('no such host');
    };
    expect(await fastSettings(given, fails)).toEqual(given);
    expect(await fastSettings(given, async () => undefined)).toEqual(given);
  });

  it('resolves localhost for real', async () => {
    expect((await fastSettings({ ...given, uri: 'bolt://localhost:7687' })).uri).toMatch(/^bolt:\/\/127\.0\.0\.1:7687$/);
  });
});
