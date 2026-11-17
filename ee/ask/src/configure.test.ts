import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AI_DEFAULTS, AI_EFFORTS, AI_LIMITS } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { configureAsk } from './configure.js';
import { createEnterpriseExtension } from './index.js';
import { parseKeyText } from '@neburyx/ee-ai-runtime';
import { makeAskFolder, removeAskFolders } from './testing/ask-folder.js';

const folder = mkdtempSync(join(tmpdir(), 'ee-ask-configure-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function keyFile(name: string, mode: number, content = 'not-a-real-key'): string {
  const path = join(folder, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

type Env = Record<string, string | undefined>;
const MAPPING = '/etc/neburyx/mapping';
const COMPLETE: Env = { NEBURYX_ASK_API_KEY: 'SENTINEL-KEY-VALUE', NEBURYX_ASK_MAPPING_FOLDER: MAPPING };
const withEnv = (extra: Env, base: Env = COMPLETE): Env => ({ ...base, ...extra });
const problemsOf = async (env: Env): Promise<readonly string[]> => {
  const { outcome } = await configureAsk(env);
  return outcome.ok ? [] : outcome.problems;
};
const keyFileEnv = (path: string): Env => ({ NEBURYX_ASK_API_KEY_FILE: path, NEBURYX_ASK_MAPPING_FOLDER: MAPPING });

describe('a complete configuration', () => {
  it('is accepted, with every default filled in', async () => {
    const { outcome, configuration } = await configureAsk(COMPLETE);
    expect(outcome).toEqual({ ok: true });
    expect(configuration).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      key: { kind: 'env', name: 'NEBURYX_ASK_API_KEY' },
      cache: { enabled: AI_DEFAULTS.cache.enabled, ttl: AI_DEFAULTS.cache.ttl },
      mappingFolder: MAPPING,
      limits: { timeoutMs: AI_DEFAULTS.timeoutMs, maxRetries: AI_DEFAULTS.maxRetries, maxTokens: AI_DEFAULTS.maxTokens, effort: AI_DEFAULTS.effort },
    });
  });

  it('takes each setting from its variable', async () => {
    const { configuration } = await configureAsk(withEnv({ NEBURYX_ASK_PROVIDER: 'anthropic', NEBURYX_ASK_CLASSIFICATION_MODEL: 'claude-sonnet-5-5', NEBURYX_ASK_EFFORT: 'max', NEBURYX_ASK_TIMEOUT_MS: '5000', NEBURYX_ASK_MAX_RETRIES: '2', NEBURYX_ASK_MAX_TOKENS: '100' }));
    expect(configuration).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', mappingFolder: MAPPING, limits: { timeoutMs: 5_000, maxRetries: 2, maxTokens: 100, effort: 'max' } });
  });

  it('uses the default effort, and each effort it is given', async () => {
    expect((await configureAsk(COMPLETE)).configuration?.limits.effort).toBe(AI_DEFAULTS.effort);
    for (const effort of AI_EFFORTS) expect((await configureAsk(withEnv({ NEBURYX_ASK_EFFORT: effort }))).configuration?.limits.effort).toBe(effort);
  });

  it('accepts the limits at both ends of their range', async () => {
    for (const [name, key] of [['NEBURYX_ASK_TIMEOUT_MS', 'timeoutMs'], ['NEBURYX_ASK_MAX_RETRIES', 'maxRetries'], ['NEBURYX_ASK_MAX_TOKENS', 'maxTokens']] as const) {
      const range = AI_LIMITS[key];
      expect((await configureAsk(withEnv({ [name]: String(range.min) }))).configuration?.limits[key]).toBe(range.min);
      expect((await configureAsk(withEnv({ [name]: String(range.max) }))).configuration?.limits[key]).toBe(range.max);
    }
  });

  it('refuses a start while ANTHROPIC_CUSTOM_HEADERS is set, naming the variable and not its value', async () => {
    const problems = await problemsOf(withEnv({ ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer secret-value' }));
    expect(problems.join(' ')).toContain('ANTHROPIC_CUSTOM_HEADERS');
    expect(problems.join(' ')).not.toContain('secret-value');
    expect(await problemsOf(withEnv({ ANTHROPIC_CUSTOM_HEADERS: '' }))).toEqual([expect.stringContaining('ANTHROPIC_CUSTOM_HEADERS')]);
  });

  it('refuses a missing key even when the environment holds the usual credential variables, and prints none of their values', async () => {
    const problems = (await problemsOf({ NEBURYX_ASK_MAPPING_FOLDER: MAPPING, ANTHROPIC_API_KEY: 'value-one', ANTHROPIC_AUTH_TOKEN: 'value-two', ANTHROPIC_PROFILE: 'value-three' })).join(' ');
    expect(problems).toContain('NEBURYX_ASK_API_KEY');
    expect(problems).not.toMatch(/value-(one|two|three)/);
  });

  it('accepts a key file that only its owner can read, also through a symbolic link', async () => {
    const path = keyFile('owner-only', 0o600);
    expect(await problemsOf(keyFileEnv(path))).toEqual([]);
    const link = join(folder, 'link-to-owner-only');
    symlinkSync(path, link);
    expect(await problemsOf(keyFileEnv(link))).toEqual([]);
    expect((await configureAsk(keyFileEnv(path))).configuration?.key).toEqual({ kind: 'file', path });
  });
});

describe('a missing or empty setting', () => {
  it.each([
    ['the mapping folder', { NEBURYX_ASK_API_KEY: 'k' }, 'NEBURYX_ASK_MAPPING_FOLDER is required when the AI preview is on'],
    ['the key and the key file', { NEBURYX_ASK_MAPPING_FOLDER: MAPPING }, 'NEBURYX_ASK_API_KEY or NEBURYX_ASK_API_KEY_FILE is required when the AI preview is on'],
  ])('refuses a configuration with no %s, naming the variable', async (_name, env, problem) => {
    expect(await problemsOf(env)).toEqual([problem]);
  });

  it('counts an empty value as not set: the defaults apply and a required setting is missing', async () => {
    const { configuration } = await configureAsk(withEnv({ NEBURYX_ASK_PROVIDER: '', NEBURYX_ASK_CLASSIFICATION_MODEL: '', NEBURYX_ASK_EFFORT: '', NEBURYX_ASK_TIMEOUT_MS: '', NEBURYX_ASK_MAX_RETRIES: '', NEBURYX_ASK_MAX_TOKENS: '', NEBURYX_ASK_API_KEY_FILE: '' }));
    expect(configuration).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', limits: { timeoutMs: AI_DEFAULTS.timeoutMs, maxRetries: AI_DEFAULTS.maxRetries, maxTokens: AI_DEFAULTS.maxTokens, effort: AI_DEFAULTS.effort } });
    expect(await problemsOf(withEnv({ NEBURYX_ASK_API_KEY: '' }))).toEqual(['NEBURYX_ASK_API_KEY or NEBURYX_ASK_API_KEY_FILE is required when the AI preview is on']);
    expect(await problemsOf(withEnv({ NEBURYX_ASK_MAPPING_FOLDER: '' }))).toEqual(['NEBURYX_ASK_MAPPING_FOLDER is required when the AI preview is on']);
  });

  it('reports every problem at once, and builds nothing', async () => {
    const { outcome, configuration } = await configureAsk({});
    expect(outcome.ok ? [] : outcome.problems).toEqual(['NEBURYX_ASK_MAPPING_FOLDER is required when the AI preview is on', 'NEBURYX_ASK_API_KEY or NEBURYX_ASK_API_KEY_FILE is required when the AI preview is on']);
    expect(configuration).toBeUndefined();
  });
});

describe('a setting that is not accepted', () => {
  it('refuses an unknown provider, naming the variable and not the value', async () => {
    const problems = await problemsOf(withEnv({ NEBURYX_ASK_PROVIDER: 'SENTINEL-PROVIDER' }));
    expect(problems).toEqual(['NEBURYX_ASK_PROVIDER must be anthropic']);
  });

  it('refuses an unknown effort, naming the variable and not the value', async () => {
    const problems = await problemsOf(withEnv({ NEBURYX_ASK_EFFORT: 'SENTINEL-EFFORT' }));
    expect(problems).toEqual([`NEBURYX_ASK_EFFORT must be ${AI_EFFORTS.join(', ')}`]);
  });

  it('refuses a mapping folder that is not an absolute path, without the value', async () => {
    expect(await problemsOf(withEnv({ NEBURYX_ASK_MAPPING_FOLDER: 'SENTINEL/relative' }))).toEqual(['NEBURYX_ASK_MAPPING_FOLDER must be an absolute path']);
  });

  it.each([
    ['NEBURYX_ASK_TIMEOUT_MS', 'timeoutMs'],
    ['NEBURYX_ASK_MAX_RETRIES', 'maxRetries'],
    ['NEBURYX_ASK_MAX_TOKENS', 'maxTokens'],
  ] as const)('refuses a value of %s out of range or not a whole number, naming the variable and never the value', async (name, key) => {
    const { min, max } = AI_LIMITS[key];
    const bad = [String(max + 1), '-1', '1.5', '1e3', '12abc', ' 12', 'SENTINEL-VALUE', ...(min > 0 ? [String(min - 1)] : [])];
    for (const value of bad) {
      const problems = await problemsOf(withEnv({ [name]: value }));
      expect(problems, value).toEqual([`${name} must be a whole number from ${min} to ${max}`]);
      expect(problems.join('')).not.toContain(value.trim() === '' ? 'never' : value.trim());
    }
  });
});

describe('the key and the key file', () => {
  it('refuses both set at once, naming both variables and no value', async () => {
    const problems = await problemsOf(withEnv({ NEBURYX_ASK_API_KEY_FILE: keyFile('both-key', 0o600) }));
    expect(problems).toEqual(['NEBURYX_ASK_API_KEY and NEBURYX_ASK_API_KEY_FILE are both set; set one']);
    expect(problems.join('')).not.toContain('SENTINEL-KEY-VALUE');
  });

  it('keeps the name of the variable, never the key itself, in the configuration', async () => {
    const { configuration } = await configureAsk(COMPLETE);
    expect(JSON.stringify(configuration)).not.toContain('SENTINEL-KEY-VALUE');
  });

  it('refuses a key file that is not an absolute path', async () => {
    expect(await problemsOf(keyFileEnv('relative/key'))).toEqual(['NEBURYX_ASK_API_KEY_FILE must be an absolute path']);
  });
});

describe('a key that is given by a file', () => {
  it.each([
    ['a file that does not exist', () => join(folder, 'no-such-key'), 'NEBURYX_ASK_API_KEY_FILE: the file does not exist'],
    ['a folder', () => { const path = join(folder, 'a-folder'); mkdirSync(path); return path; }, 'NEBURYX_ASK_API_KEY_FILE: the path is not a regular file'],
    ['an empty file', () => keyFile('empty-key', 0o600, ''), 'NEBURYX_ASK_API_KEY_FILE: the file is empty'],
    ['a file that group can read', () => keyFile('group-key', 0o640), 'NEBURYX_ASK_API_KEY_FILE: the file can be read by group or others; owner-only access is required (mode 0600)'],
    ['a file that everybody can read', () => keyFile('world-key', 0o644), 'NEBURYX_ASK_API_KEY_FILE: the file can be read by group or others; owner-only access is required (mode 0600)'],
  ])('is refused for %s, naming the variable and the reason, and never the content', async (_name, make, problem) => {
    expect(await problemsOf(keyFileEnv(make()))).toEqual([problem]);
  });

  it.skipIf(process.getuid?.() === 0)('is refused for a file that its owner cannot read', async () => {
    expect(await problemsOf(keyFileEnv(keyFile('write-only-key', 0o200)))).toEqual(['NEBURYX_ASK_API_KEY_FILE: the file cannot be read by this process']);
  });

  it('is never read: a file with a sentinel is not echoed in any problem', async () => {
    const problems = await problemsOf(keyFileEnv(keyFile('sentinel-key', 0o640, 'SENTINEL-KEY-CONTENT')));
    expect(problems.join('')).not.toContain('SENTINEL-KEY-CONTENT');
  });
});

describe('the text of a key file', () => {
  it.each([
    ['two assignments', 'A_KEY=SENTINEL-ONE\nB_KEY=SENTINEL-TWO\n', 'the file holds more than one assignment; give one key'],
    ['an empty value', 'ANTHROPIC_API_KEY=\n', 'the assignment has an empty value'],
    ['an empty quoted value', 'ANTHROPIC_API_KEY=""\n', 'the assignment has an empty value'],
    ['only comments', '# SENTINEL-NOTE\n', 'the file holds no key'],
    ['two lines', 'SENTINEL-ONE\nSENTINEL-TWO\n', 'the file holds more than one line; give one key'],
  ])('is refused for %s, naming the variable and holding no part of the file', async (_name, text, reason) => {
    const path = keyFile('text-key', 0o600, text);
    const problems = await problemsOf(keyFileEnv(path));
    expect(problems).toEqual([`NEBURYX_ASK_API_KEY_FILE: ${reason}`]);
    expect(problems.join('')).not.toContain('SENTINEL');
  });

  it.each([
    ['a bare key', 'sk-test-123\n'],
    ['a NAME=value line', 'ANTHROPIC_API_KEY=sk-test-123\n'],
    ['a name that starts with an underscore', '_KEY=sk-test-123\n'],
    ['an export line', 'export ANTHROPIC_API_KEY=sk-test-123\n'],
    ['a double-quoted value', 'ANTHROPIC_API_KEY="sk-test-123"\n'],
    ['a single-quoted value', "ANTHROPIC_API_KEY='sk-test-123'\n"],
    ['comments and blank lines around one assignment', '# the key\n\nANTHROPIC_API_KEY = sk-test-123\r\n\n'],
  ])('is accepted for %s and reads the same key', async (_name, text) => {
    expect(parseKeyText(text)).toEqual({ ok: true, key: 'sk-test-123' });
    expect(await problemsOf(keyFileEnv(keyFile('form-key', 0o600, text)))).toEqual([]);
  });
});

describe('a file that fails an earlier check', () => {
  it('is not read: a group-readable file with two assignments gets only the mode problem', async () => {
    const problems = await problemsOf(keyFileEnv(keyFile('loose-two-key', 0o640, 'A_KEY=one\nB_KEY=two\n')));
    expect(problems).toEqual(['NEBURYX_ASK_API_KEY_FILE: the file can be read by group or others; owner-only access is required (mode 0600)']);
  });
});

describe('a line that is not a NAME=value assignment', () => {
  it.each([
    ['a lower-case name', 'name=sk-test-123', 'name=sk-test-123'],
    ['a name that starts with a digit', '1NAME=sk-test-123', '1NAME=sk-test-123'],
    ['a bare key that ends in padding', 'sk-test-123==', 'sk-test-123=='],
    ['mismatched quotes', 'ANTHROPIC_API_KEY="sk-test-123\'', "\"sk-test-123'"],
    ['a one-sided quote', 'ANTHROPIC_API_KEY="sk-test-123', '"sk-test-123'],
    ['a CRLF file', 'ANTHROPIC_API_KEY=sk-test-123\r\n', 'sk-test-123'],
    ['surrounding whitespace', '  \t ANTHROPIC_API_KEY=sk-test-123  \n\n', 'sk-test-123'],
  ])('reads %s as given', (_name, text, key) => {
    expect(parseKeyText(text)).toEqual({ ok: true, key });
  });
});

describe('the prompt cache settings', () => {
  const cacheOf = async (env: Env = COMPLETE) => (await configureAsk(env)).configuration?.cache;

  it('are on with a 5 minute lifetime when nothing is given', async () => {
    expect(await cacheOf()).toEqual({ enabled: true, ttl: '5m' });
  });

  it.each([
    ['off', { NEBURYX_AI_CACHE: 'off' }, { enabled: false, ttl: '5m' }],
    ['on', { NEBURYX_AI_CACHE: 'on' }, { enabled: true, ttl: '5m' }],
    ['1h', { NEBURYX_AI_CACHE_TTL: '1h' }, { enabled: true, ttl: '1h' }],
    ['5m', { NEBURYX_AI_CACHE_TTL: '5m' }, { enabled: true, ttl: '5m' }],
    ['both', { NEBURYX_AI_CACHE: 'off', NEBURYX_AI_CACHE_TTL: '1h' }, { enabled: false, ttl: '1h' }],
  ])('are taken from the environment: %s', async (_name, env, expected) => {
    expect(await cacheOf(withEnv(env))).toEqual(expected);
  });

  it('count an empty value of either variable as not set', async () => {
    expect(await cacheOf(withEnv({ NEBURYX_AI_CACHE: '', NEBURYX_AI_CACHE_TTL: '' }))).toEqual({ enabled: true, ttl: '5m' });
    expect(await problemsOf(withEnv({ NEBURYX_AI_CACHE: '', NEBURYX_AI_CACHE_TTL: '' }))).toEqual([]);
  });

  it.each([
    ['NEBURYX_AI_CACHE', ['ON', 'true', '1', 'yes', ' ', 'SENTINEL-VALUE'], 'NEBURYX_AI_CACHE must be on or off'],
    ['NEBURYX_AI_CACHE_TTL', ['2h', '5M', '60', ' ', 'SENTINEL-VALUE'], 'NEBURYX_AI_CACHE_TTL must be 5m or 1h'],
  ])('refuse a bad value of %s, naming the variable and never the value', async (name, values, problem) => {
    for (const value of values) {
      expect(await problemsOf(withEnv({ [name]: value }))).toEqual([problem]);
    }
  });
});

describe('the enterprise extension', () => {
  const folder = makeAskFolder(['source-a']);
  afterAll(removeAskFolders);
  it('defines configure, and keeps the configuration for its routes only when it was accepted', async () => {
    const extension = createEnterpriseExtension();
    const context = { sourceIds: ['source-a'] };
    expect(extension.configure).toBeDefined();
    expect(extension.configuration()).toBeUndefined();
    expect(await extension.configure?.({ preview: true }, {}, context)).toMatchObject({ ok: false });
    expect(extension.configuration()).toBeUndefined();
    expect(await extension.configure?.({ preview: true }, withEnv({ NEBURYX_ASK_CLASSIFICATION_MODEL: 'claude-sonnet-5-5', NEBURYX_ASK_MAPPING_FOLDER: folder }), context)).toEqual({ ok: true });
    expect(extension.configuration()?.model).toBe('claude-sonnet-5-5');
  });

  it('loads the Ask folder when it accepts the settings, and gives it by askFolder()', async () => {
    const extension = createEnterpriseExtension();
    expect(extension.askFolder()).toBeUndefined();
    const env = withEnv({ NEBURYX_ASK_MAPPING_FOLDER: folder });
    expect(await extension.configure?.({ preview: true }, env, { sourceIds: ['source-a', 'source-b'] })).toEqual({ ok: true });
    expect(extension.askFolder()?.sourceIds).toEqual(['source-a']);
    expect(extension.askFolder()?.intent('source-a', 'byId')).toMatchObject({ kind: 'query', parameters: ['id'] });
  });

  it('refuses a folder with a bad intent, names the file and the intent, and keeps neither the configuration nor the folder', async () => {
    const bad = makeAskFolder(['source-a']);
    writeFileSync(join(bad, 'source-a', 'intents.json'), JSON.stringify({ wipe: { parameters: [], query: "MATCH (n) WHERE n.x = 'SENTINEL_TEXT' DETACH DELETE n" } }));
    const extension = createEnterpriseExtension();
    const outcome = await extension.configure?.({ preview: true }, withEnv({ NEBURYX_ASK_MAPPING_FOLDER: bad }), { sourceIds: ['source-a'] });
    expect(outcome?.ok).toBe(false);
    const problems = outcome?.ok === false ? outcome.problems.join(' ') : '';
    expect(problems).toContain('NEBURYX_ASK_MAPPING_FOLDER/source-a/intents.json: intent "wipe"');
    expect(problems).not.toContain('SENTINEL');
    expect(problems).not.toContain('SENTINEL-KEY-VALUE');
    expect(extension.configuration()).toBeUndefined();
    expect(extension.askFolder()).toBeUndefined();
  });

  it('refuses a folder that does not exist, naming the setting, and a settings error stops before the folder is read', async () => {
    const extension = createEnterpriseExtension();
    const outcome = await extension.configure?.({ preview: true }, withEnv({ NEBURYX_ASK_MAPPING_FOLDER: '/no/such/ask/folder' }), { sourceIds: ['source-a'] });
    expect(outcome?.ok === false ? outcome.problems : []).toEqual(['NEBURYX_ASK_MAPPING_FOLDER: the folder does not exist or cannot be read']);
    expect(await extension.configure?.({ preview: true }, {}, { sourceIds: ['source-a'] })).toMatchObject({ ok: false });
  });
});
