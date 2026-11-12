import { stringify } from 'yaml';
import { AI_DEFAULTS, type AiSettings } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { MappingError } from './diagnostics.js';
import { parseMapping } from './load.js';
import { baseSource } from '../testing/mapping.js';

const parseWith = (ai: unknown) => parseMapping(stringify({ sources: [baseSource()], ai }), 'neburyx.yaml');
const refusal = (ai: unknown): MappingError => {
  try {
    parseWith(ai);
  } catch (error) {
    if (error instanceof MappingError) return error;
    throw error;
  }
  throw new Error('expected the mapping to be refused');
};
const diagnostics = (error: MappingError): string => JSON.stringify(error.issues);

describe('the ai section of the mapping file', () => {
  it('holds every key as written, and every key but the preview switch is optional', () => {
    const ai = {
      preview: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      key: { env: 'ANTHROPIC_API_KEY' },
      prompts: { 'ask.plan': '/etc/neburyx/prompts/ask-plan.txt' },
      timeout_ms: 30_000,
      max_retries: 2,
      max_tokens: 4_096,
    };
    const model: AiSettings | undefined = parseWith(ai).ai;
    expect(model).toEqual(ai);
    expect(parseWith({ preview: true }).ai).toEqual({ preview: true });
    expect(parseWith({ key: { file: '/home/node/.config/neburyx/anthropic.env' } }).ai).toEqual({ key: { file: '/home/node/.config/neburyx/anthropic.env' } });
  });

  it('refuses a provider other than anthropic, naming ai.provider', () => {
    expect(refusal({ provider: 'other' }).issues.map((issue) => issue.path)).toContain('ai.provider');
  });

  it.each([
    ['a text', 'sk-SECRET-VALUE-1234'],
    ['both env and file', { env: 'ANTHROPIC_API_KEY', file: '/run/secrets/key' }],
    ['neither env nor file', {}],
    ['an unknown key', { env: 'ANTHROPIC_API_KEY', value: 'sk-SECRET-VALUE-1234' }],
  ])('refuses a key given as %s, naming ai.key and never printing the value', (_name, key) => {
    const error = refusal({ key });
    expect(error.issues.some((issue) => issue.path.startsWith('ai.key'))).toBe(true);
    expect(diagnostics(error)).not.toContain('sk-SECRET-VALUE-1234');
    expect(error.message).not.toContain('sk-SECRET-VALUE-1234');
  });

  it.each([
    ['a relative path', { file: 'keys/anthropic' }, 'ai.key.file'],
    ['an empty path', { file: '' }, 'ai.key.file'],
    ['a variable name that starts with a digit', { env: '1KEY' }, 'ai.key.env'],
    ['a variable name with a dash', { env: 'MY-KEY' }, 'ai.key.env'],
    ['an empty variable name', { env: '' }, 'ai.key.env'],
  ])('refuses %s', (_name, key, path) => {
    expect(refusal({ key }).issues.map((issue) => issue.path)).toContain(path);
  });

  it.each([
    ['a prompt file that is not absolute', { prompts: { 'ask.plan': 'prompts/ask.txt' } }, 'ai.prompts'],
    ['prompts that are a list', { prompts: ['/a'] }, 'ai.prompts'],
    ['a timeout under its range', { timeout_ms: 999 }, 'ai.timeout_ms'],
    ['a timeout over its range', { timeout_ms: 600_001 }, 'ai.timeout_ms'],
    ['a fractional timeout', { timeout_ms: 1500.5 }, 'ai.timeout_ms'],
    ['retries over their range', { max_retries: 6 }, 'ai.max_retries'],
    ['negative retries', { max_retries: -1 }, 'ai.max_retries'],
    ['a token limit of zero', { max_tokens: 0 }, 'ai.max_tokens'],
    ['a token limit over its range', { max_tokens: 32_769 }, 'ai.max_tokens'],
    ['a limit given as text', { max_tokens: '8192' }, 'ai.max_tokens'],
  ])('refuses %s, naming the key', (_name, ai, path) => {
    expect(refusal(ai).issues.map((issue) => issue.path).some((issuePath) => issuePath.startsWith(path))).toBe(true);
  });

  it.each(['properties', 'temperature', 'top_p', 'top_k', 'thinking', 'api_key'])('refuses %s as a key the section does not have', (key) => {
    expect(() => parseWith({ [key]: 1 })).toThrow(MappingError);
  });

  it('accepts the limits at both ends of their ranges', () => {
    expect(parseWith({ timeout_ms: 1_000, max_retries: 0, max_tokens: 1 }).ai).toEqual({ timeout_ms: 1_000, max_retries: 0, max_tokens: 1 });
    expect(parseWith({ timeout_ms: 600_000, max_retries: 5, max_tokens: 32_768 }).ai).toEqual({ timeout_ms: 600_000, max_retries: 5, max_tokens: 32_768 });
  });

  it('has hypothesis defaults inside the ranges the file accepts', () => {
    expect(AI_DEFAULTS).toEqual({ timeoutMs: 60_000, maxRetries: 0, maxTokens: 8_192 });
    expect(parseWith({ timeout_ms: AI_DEFAULTS.timeoutMs, max_retries: AI_DEFAULTS.maxRetries, max_tokens: AI_DEFAULTS.maxTokens }).ai).toBeDefined();
  });
});
