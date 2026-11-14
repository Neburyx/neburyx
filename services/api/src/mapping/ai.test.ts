import { stringify } from 'yaml';
import type { AiSettings } from '@neburyx/contracts';
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

/** The moved keys and their replacement, as AI_MOVED_KEYS in packages/contracts/src/ai.ts holds them (not exported from the package index). */
const AI_MOVED_KEYS: Readonly<Record<string, string>> = {
  provider: 'NEBURYX_ASK_PROVIDER',
  model: 'NEBURYX_ASK_CLASSIFICATION_MODEL',
  key: 'NEBURYX_ASK_API_KEY or NEBURYX_ASK_API_KEY_FILE',
  effort: 'NEBURYX_ASK_EFFORT',
  timeout_ms: 'NEBURYX_ASK_TIMEOUT_MS',
  max_retries: 'NEBURYX_ASK_MAX_RETRIES',
  max_tokens: 'NEBURYX_ASK_MAX_TOKENS',
  cache: 'NEBURYX_AI_CACHE and NEBURYX_AI_CACHE_TTL',
};

const MOVED_VALUES: Readonly<Record<string, unknown>> = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  key: { env: 'ANTHROPIC_API_KEY' },
  effort: 'high',
  timeout_ms: 30_000,
  max_retries: 2,
  max_tokens: 4_096,
  cache: { enabled: false, ttl: '1h' },
};

describe('the ai section of the mapping file', () => {
  it('holds the preview switch as written, and the switch is optional', () => {
    const model: AiSettings | undefined = parseWith({ preview: true }).ai;
    expect(model).toEqual({ preview: true });
    expect(parseWith({ preview: false }).ai).toEqual({ preview: false });
    expect(parseWith({}).ai).toEqual({});
  });

  it('has a test value for every key that moved', () => {
    expect(Object.keys(MOVED_VALUES).sort()).toEqual(Object.keys(AI_MOVED_KEYS).sort());
  });

  it.each(Object.keys(AI_MOVED_KEYS))('refuses %s, naming the key and the variable that replaces it', (key) => {
    const error = refusal({ preview: true, [key]: MOVED_VALUES[key] });
    const text = error.issues.map((issue) => `${issue.path} ${issue.reason}`).join(' ');
    expect(text).toContain(`ai.${key}`);
    expect(text).toContain(AI_MOVED_KEYS[key]);
  });

  it('never prints the value of a refused key', () => {
    const error = refusal({ preview: true, key: 'sk-SECRET-VALUE-1234', model: 'MODEL-SENTINEL', cache: { ttl: 'TTL-SENTINEL' } });
    for (const sentinel of ['sk-SECRET-VALUE-1234', 'MODEL-SENTINEL', 'TTL-SENTINEL']) {
      expect(diagnostics(error)).not.toContain(sentinel);
      expect(error.message).not.toContain(sentinel);
    }
  });

  it('names every moved key of a block that has several', () => {
    const text = refusal({ preview: true, provider: 'anthropic', max_tokens: 1 }).issues.map((issue) => issue.reason).join(' ');
    expect(text).toContain('NEBURYX_ASK_PROVIDER');
    expect(text).toContain('NEBURYX_ASK_MAX_TOKENS');
  });

  it.each(['prompts', 'properties', 'pii_override', 'temperature', 'top_p', 'top_k', 'thinking', 'api_key', 'send_property_values'])('refuses %s as a key the section does not have', (key) => {
    const error = refusal({ [key]: 1 });
    expect(diagnostics(error)).toContain(`ai.${key}`);
    expect(diagnostics(error)).toContain('is not a known key');
  });

  it('refuses a preview that is not a boolean', () => {
    expect(() => parseWith({ preview: 'yes' })).toThrow(MappingError);
  });
});
