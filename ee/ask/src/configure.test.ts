import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AI_DEFAULTS, type AiSettings } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { configureAsk } from './configure.js';
import { createEnterpriseExtension } from './index.js';
import { parseKeyText } from './key-file.js';

const folder = mkdtempSync(join(tmpdir(), 'ee-ask-configure-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function keyFile(name: string, mode: number, content = 'not-a-real-key'): string {
  const path = join(folder, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

const ENV = { AI_TEST_KEY: 'present' };
const COMPLETE: AiSettings = { preview: true, provider: 'anthropic', model: 'claude-sonnet-5-5', key: { env: 'AI_TEST_KEY' } };
const problemsOf = async (settings: AiSettings, env: Record<string, string | undefined> = ENV): Promise<readonly string[]> => {
  const { outcome } = await configureAsk(settings, env);
  return outcome.ok ? [] : outcome.problems;
};

describe('a complete configuration', () => {
  it('is accepted, with the defaults filled in for the limits it does not give', async () => {
    const { outcome, configuration } = await configureAsk(COMPLETE, ENV);
    expect(outcome).toEqual({ ok: true });
    expect(configuration).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', key: { kind: 'env', name: 'AI_TEST_KEY' }, limits: { timeoutMs: AI_DEFAULTS.timeoutMs, maxRetries: AI_DEFAULTS.maxRetries, maxTokens: AI_DEFAULTS.maxTokens } });
  });

  it('uses the default effort, and the one it is given', async () => {
    expect((await configureAsk(COMPLETE, ENV)).configuration?.limits.effort).toBe(AI_DEFAULTS.effort);
    expect((await configureAsk({ ...COMPLETE, effort: 'max' }, ENV)).configuration?.limits.effort).toBe('max');
  });

  it('refuses a start while ANTHROPIC_CUSTOM_HEADERS is set, naming the variable and not its value', async () => {
    const problems = await problemsOf(COMPLETE, { ...ENV, ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer secret-value' });
    expect(problems.join(' ')).toContain('ANTHROPIC_CUSTOM_HEADERS');
    expect(problems.join(' ')).not.toContain('secret-value');
    expect(await problemsOf(COMPLETE, { ...ENV, ANTHROPIC_CUSTOM_HEADERS: '' })).not.toEqual([]);
  });

  it('refuses a missing key even when the environment holds the usual credential variables, and prints none of their values', async () => {
    const { key: _key, ...withoutKey } = COMPLETE;
    const problems = (await problemsOf(withoutKey, { ANTHROPIC_API_KEY: 'value-one', ANTHROPIC_AUTH_TOKEN: 'value-two', ANTHROPIC_PROFILE: 'value-three' })).join(' ');
    expect(problems).toContain('ai.key');
    expect(problems).not.toMatch(/value-(one|two|three)/);
  });

  it('keeps the limits it is given', async () => {
    const { configuration } = await configureAsk({ ...COMPLETE, timeout_ms: 5_000, max_retries: 2, max_tokens: 100 }, ENV);
    expect(configuration?.limits).toEqual({ timeoutMs: 5_000, maxRetries: 2, maxTokens: 100, effort: AI_DEFAULTS.effort });
  });

  it('accepts a key file that only its owner can read, also through a symbolic link', async () => {
    const path = keyFile('owner-only', 0o600);
    expect(await problemsOf({ ...COMPLETE, key: { file: path } })).toEqual([]);
    const link = join(folder, 'link-to-owner-only');
    symlinkSync(path, link);
    expect(await problemsOf({ ...COMPLETE, key: { file: link } })).toEqual([]);
    expect((await configureAsk({ ...COMPLETE, key: { file: path } }, {})).configuration?.key).toEqual({ kind: 'file', path });
  });
});

describe('a missing setting', () => {
  it.each([
    ['provider', { ...COMPLETE, provider: undefined }, 'ai.provider is required when the AI preview is on'],
    ['model', { ...COMPLETE, model: undefined }, 'ai.model is required when the AI preview is on'],
    ['key', { ...COMPLETE, key: undefined }, 'ai.key is required when the AI preview is on'],
  ])('refuses a configuration with no %s, naming the setting', async (_name, settings, problem) => {
    expect(await problemsOf(settings)).toEqual([problem]);
  });

  it('reports every problem at once, and builds nothing', async () => {
    const { outcome, configuration } = await configureAsk({ preview: true }, ENV);
    expect(outcome).toMatchObject({ ok: false, problems: expect.arrayContaining(['ai.provider is required when the AI preview is on', 'ai.model is required when the AI preview is on', 'ai.key is required when the AI preview is on']) });
    expect(outcome.ok ? [] : outcome.problems).toHaveLength(3);
    expect(configuration).toBeUndefined();
  });
});

describe('a key that is given by an environment variable', () => {
  it.each([['not set', {}], ['empty', { AI_TEST_KEY: '' }]])('is refused when the variable is %s, naming the variable and no value', async (_name, env) => {
    expect(await problemsOf(COMPLETE, env)).toEqual(['ai.key.env: the variable AI_TEST_KEY is not set or is empty']);
  });
});

describe('a key that is given by a file', () => {
  it.each([
    ['a file that does not exist', () => join(folder, 'no-such-key'), 'ai.key.file: the file does not exist'],
    ['a folder', () => { const path = join(folder, 'a-folder'); mkdirSync(path); return path; }, 'ai.key.file: the path is not a regular file'],
    ['an empty file', () => keyFile('empty-key', 0o600, ''), 'ai.key.file: the file is empty'],
    ['a file that group can read', () => keyFile('group-key', 0o640), 'ai.key.file: the file can be read by group or others; owner-only access is required (mode 0600)'],
    ['a file that everybody can read', () => keyFile('world-key', 0o644), 'ai.key.file: the file can be read by group or others; owner-only access is required (mode 0600)'],
  ])('is refused for %s, naming the setting and the reason, and never the content', async (_name, make, problem) => {
    expect(await problemsOf({ ...COMPLETE, key: { file: make() } })).toEqual([problem]);
  });

  it.skipIf(process.getuid?.() === 0)('is refused for a file that its owner cannot read', async () => {
    expect(await problemsOf({ ...COMPLETE, key: { file: keyFile('write-only-key', 0o200) } })).toEqual(['ai.key.file: the file cannot be read by this process']);
  });

  it('is never read: a file with a sentinel is not echoed in any problem', async () => {
    const problems = await problemsOf({ ...COMPLETE, key: { file: keyFile('sentinel-key', 0o640, 'SENTINEL-KEY-CONTENT') } });
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
  ])('is refused for %s, naming the path and holding no part of the file', async (_name, text, reason) => {
    const path = keyFile('text-key', 0o600, text);
    const problems = await problemsOf({ ...COMPLETE, key: { file: path } });
    expect(problems).toEqual([`ai.key.file: ${path}: ${reason}`]);
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
    expect(await problemsOf({ ...COMPLETE, key: { file: keyFile('form-key', 0o600, text) } })).toEqual([]);
  });
});

describe('a file that fails an earlier check', () => {
  it('is not read: a group-readable file with two assignments gets only the mode problem', async () => {
    const problems = await problemsOf({ ...COMPLETE, key: { file: keyFile('loose-two-key', 0o640, 'A_KEY=one\nB_KEY=two\n') } });
    expect(problems).toEqual(['ai.key.file: the file can be read by group or others; owner-only access is required (mode 0600)']);
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
  const cacheOf = async (settings: AiSettings, env: Record<string, string | undefined> = ENV) => (await configureAsk(settings, env)).configuration?.cache;

  it('are on with a 5 minute lifetime when nothing is given', async () => {
    expect(await cacheOf(COMPLETE)).toEqual({ enabled: true, ttl: '5m' });
  });

  it('take the values of the file', async () => {
    expect(await cacheOf({ ...COMPLETE, cache: { enabled: false, ttl: '1h' } })).toEqual({ enabled: false, ttl: '1h' });
    expect(await cacheOf({ ...COMPLETE, cache: { ttl: '1h' } })).toEqual({ enabled: true, ttl: '1h' });
  });

  it.each([
    ['on over false', { enabled: false }, { NEBURYX_AI_CACHE: 'on' }, { enabled: true, ttl: '5m' }],
    ['off over true', { enabled: true }, { NEBURYX_AI_CACHE: 'off' }, { enabled: false, ttl: '5m' }],
    ['1h over 5m', { ttl: '5m' as const }, { NEBURYX_AI_CACHE_TTL: '1h' }, { enabled: true, ttl: '1h' }],
    ['5m over 1h', { ttl: '1h' as const }, { NEBURYX_AI_CACHE_TTL: '5m' }, { enabled: true, ttl: '5m' }],
    ['both', { enabled: true, ttl: '5m' as const }, { NEBURYX_AI_CACHE: 'off', NEBURYX_AI_CACHE_TTL: '1h' }, { enabled: false, ttl: '1h' }],
  ])('are overridden by the environment: %s', async (_name, cache, env, expected) => {
    expect(await cacheOf({ ...COMPLETE, cache }, { ...ENV, ...env })).toEqual(expected);
  });

  it('count an empty value of either variable as not set, over the file and over the default', async () => {
    expect(await cacheOf(COMPLETE, { ...ENV, NEBURYX_AI_CACHE: '', NEBURYX_AI_CACHE_TTL: '' })).toEqual({ enabled: true, ttl: '5m' });
    expect(await cacheOf({ ...COMPLETE, cache: { enabled: false, ttl: '1h' } }, { ...ENV, NEBURYX_AI_CACHE: '', NEBURYX_AI_CACHE_TTL: '' })).toEqual({ enabled: false, ttl: '1h' });
    expect(await problemsOf(COMPLETE, { ...ENV, NEBURYX_AI_CACHE: '', NEBURYX_AI_CACHE_TTL: '' })).toEqual([]);
  });

  it.each([
    ['NEBURYX_AI_CACHE', ['ON', 'true', '1', 'yes', ' ', 'SENTINEL-VALUE'], 'NEBURYX_AI_CACHE must be on or off'],
    ['NEBURYX_AI_CACHE_TTL', ['2h', '5M', '60', ' ', 'SENTINEL-VALUE'], 'NEBURYX_AI_CACHE_TTL must be 5m or 1h'],
  ])('refuse a bad value of %s, naming the variable and never the value', async (name, values, problem) => {
    for (const value of values) {
      expect(await problemsOf(COMPLETE, { ...ENV, [name]: value })).toEqual([problem]);
    }
  });
});

describe('the enterprise extension', () => {
  it('defines configure, and keeps the configuration for its routes only when it was accepted', async () => {
    const extension = createEnterpriseExtension();
    expect(extension.configure).toBeDefined();
    expect(extension.configuration()).toBeUndefined();
    expect(await extension.configure?.({ preview: true }, ENV)).toMatchObject({ ok: false });
    expect(extension.configuration()).toBeUndefined();
    expect(await extension.configure?.(COMPLETE, ENV)).toEqual({ ok: true });
    expect(extension.configuration()?.model).toBe('claude-sonnet-5-5');
  });
});
