import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_DEFAULTS, AI_LIMITS } from '@neburyx/contracts';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { afterAll, describe, expect, it } from 'vitest';
import { parseMapping } from '../mapping/load.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';

const GUIDE = readFileSync(join(fileURLToPath(new URL('../../../../', import.meta.url)), 'docs', 'ai-preview.md'), 'utf8');

function yamlBlockAfter(heading: string): string {
  const section = GUIDE.slice(GUIDE.indexOf(`## ${heading}`));
  const match = /```yaml\n([\s\S]*?)```/.exec(section);
  expect(match, `a yaml block under ${heading}`).not.toBeNull();
  return match?.[1] ?? '';
}

const ASK_VARIABLES = {
  provider: 'NEBURYX_ASK_PROVIDER',
  model: 'NEBURYX_ASK_CLASSIFICATION_MODEL',
  key: 'NEBURYX_ASK_API_KEY',
  keyFile: 'NEBURYX_ASK_API_KEY_FILE',
  folder: 'NEBURYX_ASK_MAPPING_FOLDER',
  effort: 'NEBURYX_ASK_EFFORT',
  timeoutMs: 'NEBURYX_ASK_TIMEOUT_MS',
  maxRetries: 'NEBURYX_ASK_MAX_RETRIES',
  maxTokens: 'NEBURYX_ASK_MAX_TOKENS',
} as const;

const MOVED_KEYS: Readonly<Record<string, readonly string[]>> = {
  provider: [ASK_VARIABLES.provider],
  model: [ASK_VARIABLES.model],
  key: [ASK_VARIABLES.key, ASK_VARIABLES.keyFile],
  effort: [ASK_VARIABLES.effort],
  timeout_ms: [ASK_VARIABLES.timeoutMs],
  max_retries: [ASK_VARIABLES.maxRetries],
  max_tokens: [ASK_VARIABLES.maxTokens],
  cache: ['NEBURYX_AI_CACHE', 'NEBURYX_AI_CACHE_TTL'],
};

afterAll(removeAskFolders);

describe('the example of the AI settings in the AI preview guide', () => {
  it('is accepted by the mapping schema and by configure', async () => {
    const example = yamlBlockAfter('What to set in the mapping file');
    const mapping = parseMapping(`sources: []\n${example}`, 'ai-preview.md');
    expect(mapping.ai).toEqual({ preview: true });
    const outcome = await createEnterpriseExtension().configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder([]) }, { sourceIds: [] });
    expect(outcome).toEqual({ ok: true });
  });

  it('names every variable Ask reads, with the default and the range of each limit as the product has them', () => {
    for (const name of Object.values(ASK_VARIABLES)) expect(GUIDE, name).toContain(`\`${name}\``);
    const row = (name: string): string => GUIDE.split('\n').find((line) => line.startsWith(`| \`${name}\``)) ?? '';
    const limits = [
      [ASK_VARIABLES.timeoutMs, AI_LIMITS.timeoutMs, AI_DEFAULTS.timeoutMs],
      [ASK_VARIABLES.maxRetries, AI_LIMITS.maxRetries, AI_DEFAULTS.maxRetries],
      [ASK_VARIABLES.maxTokens, AI_LIMITS.maxTokens, AI_DEFAULTS.maxTokens],
    ] as const;
    for (const [name, range, fallback] of limits) {
      expect(row(name), name).toContain(`from ${range.min} to ${range.max}`);
      expect(row(name), name).toContain(`The default is ${fallback}`);
    }
  });

  it('lists each key that moved to the environment with the variable that replaces it', () => {
    for (const [key, variables] of Object.entries(MOVED_KEYS)) {
      const line = GUIDE.split('\n').find((entry) => entry.startsWith(`| \`ai.${key}\``)) ?? '';
      for (const name of variables) expect(line, key).toContain(name);
    }
  });

  it('names none of the removed settings or flow', () => {
    expect(GUIDE).not.toMatch(/pii_override|piiPropertiesSent|instructionsSha256|ai\.prompts|ai\.properties|\/v1\/ask\/(plan|run|edit|cancel)/);
  });
});
