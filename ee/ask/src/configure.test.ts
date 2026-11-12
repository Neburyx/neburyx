import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AI_DEFAULTS, type AiSettings } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { configureAsk } from './configure.js';
import { createEnterpriseExtension } from './index.js';

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
    expect(configuration?.registry.resolve('summary.view', { view: 'v' }).record.source).toBe('builtin');
  });

  it('keeps the limits it is given', async () => {
    const { configuration } = await configureAsk({ ...COMPLETE, timeout_ms: 5_000, max_retries: 2, max_tokens: 100 }, ENV);
    expect(configuration?.limits).toEqual({ timeoutMs: 5_000, maxRetries: 2, maxTokens: 100 });
  });

  it('accepts a key file that only its owner can read, also through a symbolic link', async () => {
    const path = keyFile('owner-only', 0o600);
    expect(await problemsOf({ ...COMPLETE, key: { file: path } })).toEqual([]);
    const link = join(folder, 'link-to-owner-only');
    symlinkSync(path, link);
    expect(await problemsOf({ ...COMPLETE, key: { file: link } })).toEqual([]);
    expect((await configureAsk({ ...COMPLETE, key: { file: path } }, {})).configuration?.key).toEqual({ kind: 'file', path });
  });

  it('uses a prompt override it is given', async () => {
    const prompt = keyFile('summary.txt', 0o600, 'Summarise {{view}}');
    const { configuration } = await configureAsk({ ...COMPLETE, prompts: { 'summary.view': prompt } }, ENV);
    expect(configuration?.registry.resolve('summary.view', { view: 'v' })).toMatchObject({ text: 'Summarise v', record: { source: 'override' } });
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
    const { outcome, configuration } = await configureAsk({ preview: true, prompts: { 'free.text': '/x' } }, ENV);
    expect(outcome).toMatchObject({ ok: false, problems: expect.arrayContaining(['ai.provider is required when the AI preview is on', 'ai.model is required when the AI preview is on', 'ai.key is required when the AI preview is on']) });
    expect(outcome.ok ? [] : outcome.problems).toHaveLength(4);
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
