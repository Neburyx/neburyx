import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { afterAll, describe, expect, it } from 'vitest';
import { parseMapping } from '../mapping/load.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';

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

afterAll(removeAskFolders);

describe('the example mapping file of the compose install', () => {
  it('is valid as it is, with the AI preview block still commented', () => {
    expect(parseMapping(EXAMPLE, 'neburyx.example.yaml').ai).toBeUndefined();
  });

  it('points to a guide that exists', () => {
    expect(EXAMPLE).toContain('docs/ai-preview.md');
    expect(existsSync(join(fileURLToPath(new URL('../../../../', import.meta.url)), 'docs', 'ai-preview.md'))).toBe(true);
  });

  it('shows the preview switch only, commented, and none of the settings that moved to the environment', () => {
    const block = EXAMPLE.slice(EXAMPLE.indexOf(START), EXAMPLE.indexOf(END));
    expect(block.split('\n').slice(1).filter((entry) => entry !== '')).toEqual(['# ai:', '#   preview: true']);
    expect(block).not.toMatch(/provider|model|key|effort|cache|prompts|properties|pii_override|\bsk-[A-Za-z0-9]/);
  });

  it('is accepted by the mapping schema and by configure once the block is uncommented and its key variable is set', async () => {
    const mapping = parseMapping(uncommented(), 'neburyx.example.yaml');
    expect(mapping.ai).toEqual({ preview: true });
    const outcome = await createEnterpriseExtension().configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder([]) }, { sourceIds: [] });
    expect(outcome).toEqual({ ok: true });
  });
});
