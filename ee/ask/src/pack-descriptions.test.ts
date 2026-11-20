import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERDICT } from '@neburyx/ee-ai-runtime';
import { describe, expect, it } from 'vitest';

const PACKS = ['banking-fraud', 'insurance-claims'] as const;
const POLICY = /\b(?:must|should|always|never|require[sd]?|policy\s+limit|threshold|approve[sd]?|deny|denied|reject\w*|flag\w*)\b/i;
const root = fileURLToPath(new URL('../../../domain-packs/', import.meta.url));

/** Each `type:` entry of the pack with its `description:` value, read from the file's lines. */
function described(pack: string): { type: string; description: string | undefined }[] {
  const out: { type: string; description: string | undefined }[] = [];
  for (const line of readFileSync(`${root}${pack}/neburyx.yaml`, 'utf8').split('\n')) {
    const type = /^\s+- type: (\S+)$/.exec(line);
    if (type?.[1] !== undefined) out.push({ type: type[1], description: undefined });
    const description = /^\s+description: "(.*)"$/.exec(line);
    const last = out[out.length - 1];
    if (description?.[1] !== undefined && last !== undefined) last.description = description[1];
  }
  return out;
}

describe.each(PACKS)('the %s pack descriptions', (pack) => {
  const types = described(pack).filter((entry) => entry.type !== 'node_a');

  it('give every entity type and relationship type one description', () => {
    expect(types.length).toBeGreaterThan(5);
    for (const entry of types) expect(entry.description, entry.type).toBeDefined();
  });

  it('are 1 to 300 characters of plain text', () => {
    for (const entry of types) {
      expect(entry.description?.length, entry.type).toBeGreaterThan(0);
      expect(entry.description?.length, entry.type).toBeLessThanOrEqual(300);
      expect(entry.description, entry.type).not.toMatch(/[\u0000-\u001f]/);
    }
  });

  it('use no verdict word and no policy word', () => {
    for (const entry of types) {
      expect(VERDICT.test(entry.description ?? ''), `${entry.type}: verdict word`).toBe(false);
      expect(POLICY.test(entry.description ?? ''), `${entry.type}: policy word`).toBe(false);
    }
  });
});
