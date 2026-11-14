import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureAsk } from '@neburyx/ee-ask';
import { describe, expect, it } from 'vitest';
import { parseMapping } from '../mapping/load.js';

const GUIDE = readFileSync(join(fileURLToPath(new URL('../../../../', import.meta.url)), 'docs', 'ai-preview.md'), 'utf8');

function yamlBlockAfter(heading: string): string {
  const section = GUIDE.slice(GUIDE.indexOf(`## ${heading}`));
  const match = /```yaml\n([\s\S]*?)```/.exec(section);
  expect(match, `a yaml block under ${heading}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('the example of the AI settings in the AI preview guide', () => {
  it('is accepted by the mapping schema and by configure', async () => {
    const example = yamlBlockAfter('What to set in the mapping file');
    const mapping = parseMapping(`sources: []\n${example}`, 'ai-preview.md');
    expect(mapping.ai).toMatchObject({ preview: true, provider: 'anthropic', model: 'claude-sonnet-5-5', key: { env: 'ANTHROPIC_API_KEY' } });
    const { outcome } = await configureAsk(mapping.ai ?? {}, { ANTHROPIC_API_KEY: 'present' });
    expect(outcome).toEqual({ ok: true });
  });

  it('names none of the removed settings or flow', () => {
    expect(GUIDE).not.toMatch(/pii_override|piiPropertiesSent|instructionsSha256|ai\.prompts|ai\.properties|\/v1\/ask\/(plan|run|edit|cancel)/);
  });
});
