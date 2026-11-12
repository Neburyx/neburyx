import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureAsk } from '@neburyx/ee-ask';
import { describe, expect, it } from 'vitest';
import { parseMapping } from '../mapping/load.js';
import { baseSource } from '../testing/mapping.js';
import { stringify } from 'yaml';
import { aiMappingViewOf } from './mapping-view.js';

const GUIDE = readFileSync(join(fileURLToPath(new URL('../../../../', import.meta.url)), 'docs', 'ai-preview.md'), 'utf8');

function yamlBlockAfter(heading: string): string {
  const section = GUIDE.slice(GUIDE.indexOf(`## ${heading}`));
  const match = /```yaml\n([\s\S]*?)```/.exec(section);
  expect(match, `a yaml block under ${heading}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('the example of what may be sent, in the AI preview guide', () => {
  const SOURCE = baseSource({
    id: 'demo',
    entities: [
      { type: 'person', label: 'Person', stable_id: 'id', search: ['locale'], filterable: ['status'], pii: [{ property: 'ssn', class: 'text' }] },
      { type: 'company', label: 'Company', stable_id: 'id', search: ['name'] },
    ],
    relationships: [{ type: 'KNOWS', from: 'person', to: 'person', observed_at: 'since' }],
  });

  it('is accepted by the mapping schema and by the check of the property list against the mapping', async () => {
    const example = yamlBlockAfter('What may be sent to the model');
    const mapping = parseMapping(`${example}${stringify({ sources: [SOURCE] })}`, 'ai-preview.md');
    expect(mapping.ai?.properties).toEqual({ person: ['locale', 'status'], KNOWS: ['since'], company: ['*'] });
    const { outcome } = await configureAsk({ ...mapping.ai, preview: true, provider: 'anthropic', model: 'claude-sonnet-5-5', key: { env: 'AI_TEST_KEY' } }, { AI_TEST_KEY: 'present' }, aiMappingViewOf(mapping));
    expect(outcome).toEqual({ ok: true });
  });
});
