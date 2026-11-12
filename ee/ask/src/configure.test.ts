import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AI_DEFAULTS, type AiMappingView, type AiSettings } from '@neburyx/contracts';
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
const problemsOf = async (settings: AiSettings, env: Record<string, string | undefined> = ENV, view?: AiMappingView): Promise<readonly string[]> => {
  const { outcome } = await configureAsk(settings, env, view);
  return outcome.ok ? [] : outcome.problems;
};

describe('a complete configuration', () => {
  it('is accepted, with the defaults filled in for the limits it does not give', async () => {
    const { outcome, configuration } = await configureAsk(COMPLETE, ENV);
    expect(outcome).toEqual({ ok: true });
    expect(configuration).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', key: { kind: 'env', name: 'AI_TEST_KEY' }, limits: { timeoutMs: AI_DEFAULTS.timeoutMs, maxRetries: AI_DEFAULTS.maxRetries, maxTokens: AI_DEFAULTS.maxTokens } });
    expect(configuration?.registry.resolve('summary.view', { view: 'v' }).record.source).toBe('builtin');
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

const VIEW: AiMappingView = {
  types: [
    { name: 'person', kind: 'entity', properties: [{ name: 'name', pii: false }, { name: 'locale', pii: false }, { name: 'ssn', pii: true }] },
    { name: 'KNOWS', kind: 'relationship', properties: [{ name: 'since', pii: false }] },
    { name: 'link', kind: 'entity', properties: [{ name: 'a', pii: false }] },
    { name: 'link', kind: 'relationship', properties: [{ name: 'b', pii: false }] },
  ],
};
const withProperties = (properties: Record<string, string[]>, extra: Partial<AiSettings> = {}): AiSettings => ({ ...COMPLETE, properties, ...extra });

describe('the property list', () => {
  it('is refused, failing closed, when it is not empty and no mapping view is given', async () => {
    expect(await problemsOf(withProperties({ person: ['name'] }))).toEqual(['ai.properties cannot be checked: the mapping view is missing']);
    expect(await problemsOf(withProperties({}))).toEqual([]);
  });

  it('is refused for a type that the mapping does not have, naming ai.properties and the type', async () => {
    expect(await problemsOf(withProperties({ company: ['name'] }), ENV, VIEW)).toEqual(['ai.properties: company is not an entity type or a relationship type of the mapping']);
  });

  it('is refused for a name that is both an entity type and a relationship type', async () => {
    expect(await problemsOf(withProperties({ link: ['a'] }), ENV, VIEW)).toEqual(['ai.properties: link is both an entity type and a relationship type of the mapping, so it cannot be listed']);
  });

  it('is refused for a property that the mapping does not name for the type, naming the type and the property', async () => {
    expect(await problemsOf(withProperties({ person: ['name', 'nickname'] }), ENV, VIEW)).toEqual(['ai.properties.person: nickname is not a property the mapping names for it']);
  });

  it('is refused for a pii property without the override, naming the type, the property and the override', async () => {
    expect(await problemsOf(withProperties({ person: ['ssn'] }), ENV, VIEW)).toEqual(['ai.properties.person: ssn is a pii property; naming it needs ai.pii_override: true']);
    expect(await problemsOf(withProperties({ person: ['ssn'] }, { pii_override: false }), ENV, VIEW)).toHaveLength(1);
  });

  it('starts, with one warning for each pii property named, when the override is on', async () => {
    const { outcome, configuration } = await configureAsk(withProperties({ person: ['name', 'ssn'] }, { pii_override: true }), ENV, VIEW);
    expect(outcome).toEqual({ ok: true, warnings: [{ event: 'ai.pii_override', message: 'ai.properties.person: ssn is a pii property and ai.pii_override is on, so it may be sent to the model' }] });
    expect(configuration?.rules.isSendable('entity', 'person', 'ssn')).toBe(true);
    expect(configuration?.rules.isPii('entity', 'person', 'ssn')).toBe(true);
    expect(configuration?.rules.isSendable('entity', 'person', 'name')).toBe(true);
  });

  it('warns when the override is on and no pii property is named', async () => {
    const { outcome } = await configureAsk(withProperties({ person: ['name'] }, { pii_override: true }), ENV, VIEW);
    expect(outcome).toEqual({ ok: true, warnings: [{ event: 'ai.pii_override', message: 'ai.pii_override is on but no pii property is named in ai.properties' }] });
  });

  it('has no warning when the override is off and nothing pii is named', async () => {
    expect((await configureAsk(withProperties({ person: ['name'] }), ENV, VIEW)).outcome).toEqual({ ok: true });
  });

  it('lets the wildcard stand for every property that is not pii, and never a pii one', async () => {
    const { configuration } = await configureAsk(withProperties({ person: ['*'] }, { pii_override: true }), ENV, VIEW);
    const rules = configuration?.rules;
    expect(['name', 'locale'].map((name) => rules?.isSendable('entity', 'person', name))).toEqual([true, true]);
    expect(rules?.isSendable('entity', 'person', 'ssn')).toBe(false);
    expect(rules?.isPii('entity', 'person', 'ssn')).toBe(true);
  });

  it('keeps a pii property named next to the wildcard only with the override', async () => {
    expect(await problemsOf(withProperties({ person: ['*', 'ssn'] }), ENV, VIEW)).toHaveLength(1);
    const { configuration } = await configureAsk(withProperties({ person: ['*', 'ssn'] }, { pii_override: true }), ENV, VIEW);
    expect(configuration?.rules.isSendable('entity', 'person', 'ssn')).toBe(true);
  });

  it('allows nothing by default, for an unlisted property, another type and another kind', async () => {
    const none = (await configureAsk(COMPLETE, ENV, VIEW)).configuration?.rules;
    expect(none?.isSendable('entity', 'person', 'name')).toBe(false);
    const listed = (await configureAsk(withProperties({ person: ['name'] }), ENV, VIEW)).configuration?.rules;
    expect(listed?.isSendable('entity', 'person', 'name')).toBe(true);
    expect(listed?.isSendable('entity', 'person', 'locale')).toBe(false);
    expect(listed?.isSendable('relationship', 'person', 'name')).toBe(false);
    expect(listed?.isSendable('entity', 'KNOWS', 'name')).toBe(false);
  });

  it('reports every problem at once, together with those of the provider, the model and the key', async () => {
    const problems = await problemsOf({ preview: true, properties: { company: ['x'], person: ['ssn', 'nope'] } }, ENV, VIEW);
    expect(problems).toEqual(expect.arrayContaining(['ai.provider is required when the AI preview is on', 'ai.model is required when the AI preview is on', 'ai.key is required when the AI preview is on']));
    expect(problems).toHaveLength(6);
  });

  it('is kept by the extension for its routes, with the view it was given', async () => {
    const extension = createEnterpriseExtension();
    expect(await extension.configure?.(withProperties({ person: ['name'] }), ENV, VIEW)).toEqual({ ok: true });
    expect(extension.configuration()?.rules.isSendable('entity', 'person', 'name')).toBe(true);
    expect(await extension.configure?.(withProperties({ person: ['name'] }), ENV)).toMatchObject({ ok: false });
  });
});
