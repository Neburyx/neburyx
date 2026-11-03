import { describe, expect, it } from 'vitest';
import { formatSettings, generateSettings, invalidKeys, parseEnvFile, SETTING_KEYS, settingsOf } from './settings.js';

describe('generated settings', () => {
  const settings = generateSettings();

  it('are 24 letters and digits for each password and base64 of 32 bytes for the cursor key', () => {
    for (const key of ['NEBURYX_DB_ADMIN_PASSWORD', 'NEBURYX_DB_MIGRATION_PASSWORD', 'NEBURYX_DB_APP_PASSWORD', 'DEMO_NEO4J_PASSWORD'] as const) expect(settings[key]).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(Buffer.from(settings.NEBURYX_CURSOR_KEY, 'base64')).toHaveLength(32);
  });

  it('differ from each other and from one run to the next', () => {
    expect(new Set(Object.values(settings)).size).toBe(SETTING_KEYS.length);
    expect(generateSettings()).not.toEqual(settings);
  });

  it('are written as an .env file that reads back to the same values and passes the check', () => {
    const values = parseEnvFile(formatSettings(settings));
    expect(settingsOf(values)).toEqual(settings);
    expect(invalidKeys(values)).toEqual([]);
  });
});

describe('checking an existing .env', () => {
  const good = generateSettings();
  const valuesWith = (change: Record<string, string | undefined>): Map<string, string> => {
    const values = new Map<string, string>(Object.entries(good));
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    }
    return values;
  };

  it.each([
    ['a missing key', { NEBURYX_DB_APP_PASSWORD: undefined }, 'NEBURYX_DB_APP_PASSWORD'],
    ['an empty value', { NEBURYX_DB_ADMIN_PASSWORD: '' }, 'NEBURYX_DB_ADMIN_PASSWORD'],
    ['a database password with a character that is not a letter or digit', { NEBURYX_DB_MIGRATION_PASSWORD: 'abc/def' }, 'NEBURYX_DB_MIGRATION_PASSWORD'],
    ['a Neo4j password with a symbol', { DEMO_NEO4J_PASSWORD: 'abcdefgh!' }, 'DEMO_NEO4J_PASSWORD'],
    ['a Neo4j password shorter than 8 characters', { DEMO_NEO4J_PASSWORD: 'abc1234' }, 'DEMO_NEO4J_PASSWORD'],
    ['a cursor key that is not base64', { NEBURYX_CURSOR_KEY: 'not base64 at all!' }, 'NEBURYX_CURSOR_KEY'],
    ['a cursor key of fewer than 32 bytes', { NEBURYX_CURSOR_KEY: Buffer.alloc(31, 1).toString('base64') }, 'NEBURYX_CURSOR_KEY'],
  ])('names the key for %s and never its value', (_name, change, key) => {
    expect(invalidKeys(valuesWith(change))).toEqual([key]);
  });

  it('accepts a cursor key without padding and one of more than 32 bytes', () => {
    expect(invalidKeys(valuesWith({ NEBURYX_CURSOR_KEY: Buffer.alloc(33, 7).toString('base64').replace(/=+$/, '') }))).toEqual([]);
  });

  it('reads comments, quotes and blank lines', () => {
    const values = parseEnvFile('# a comment\n\nA=1\nB="two"\n  C = three \nnot a setting\n');
    expect(Object.fromEntries(values)).toEqual({ A: '1', B: 'two', C: 'three' });
  });
});
