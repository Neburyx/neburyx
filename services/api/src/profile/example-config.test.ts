import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureAsk } from '@neburyx/ee-ask';
import { describe, expect, it } from 'vitest';
import { parseMapping } from '../mapping/load.js';

const EXAMPLE = readFileSync(join(fileURLToPath(new URL('../../../../', import.meta.url)), 'deploy', 'compose', 'config', 'neburyx.example.yaml'), 'utf8');
const START = '# >>> ai preview example';
const END = '# <<< ai preview example';

function uncommented(): string {
  const lines = EXAMPLE.split('\n');
  const from = lines.indexOf(START);
  const to = lines.indexOf(END);
  expect(from, 'the start marker').toBeGreaterThan(-1);
  expect(to, 'the end marker').toBeGreaterThan(from);
  return [...lines.slice(0, from), ...lines.slice(from + 1, to).map((line) => line.replace(/^# ?/, '')), ...lines.slice(to + 1)].join('\n');
}

describe('the example mapping file of the compose install', () => {
  it('is valid as it is, with the AI preview block still commented', () => {
    expect(parseMapping(EXAMPLE, 'neburyx.example.yaml').ai).toBeUndefined();
  });

  it('points to a guide that exists', () => {
    expect(EXAMPLE).toContain('docs/ai-preview.md');
    expect(existsSync(join(fileURLToPath(new URL('../../../../', import.meta.url)), 'docs', 'ai-preview.md'))).toBe(true);
  });

  it('shows claude-sonnet-5-5, no default model, and the key by reference, all commented', () => {
    const block = EXAMPLE.slice(EXAMPLE.indexOf(START), EXAMPLE.indexOf(END));
    expect(block).toContain('model: claude-sonnet-5-5');
    expect(block).toContain('env: ANTHROPIC_API_KEY');
    expect(block).not.toMatch(/prompts|properties|pii_override/);
    for (const line of block.split('\n').slice(1).filter((entry) => entry !== '')) expect(line.startsWith('#'), line).toBe(true);
    expect(block).not.toMatch(/\bsk-[A-Za-z0-9]/);
  });

  it('is accepted by the mapping schema and by configure once the block is uncommented and its key variable is set', async () => {
    const mapping = parseMapping(uncommented(), 'neburyx.example.yaml');
    expect(mapping.ai).toMatchObject({ preview: true, provider: 'anthropic', model: 'claude-sonnet-5-5', key: { env: 'ANTHROPIC_API_KEY' } });
    const { outcome } = await configureAsk(mapping.ai ?? {}, { ANTHROPIC_API_KEY: 'not-a-real-key' });
    expect(outcome).toEqual({ ok: true });
  });
});
