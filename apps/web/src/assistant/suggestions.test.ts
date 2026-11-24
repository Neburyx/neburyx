import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SourceProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { testProfile } from '../dev/test-profile.js';
import { suggestionsOf } from './suggestions.js';

const PACKS = ['banking-fraud', 'insurance-claims'] as const;

interface Pack {
  readonly profile: SourceProfile;
  readonly type: string;
  readonly name: string;
}

function packOf(directory: string): Pack {
  const mapping = readFileSync(resolve(process.cwd(), '../../domain-packs', directory, 'neburyx.yaml'), 'utf8');
  const type = /^\s+- type: (\S+)$/m.exec(mapping)?.[1] ?? '';
  const name = /^\s+label: (\S+)$/m.exec(mapping)?.[1] ?? '';
  expect(type).not.toBe('');
  expect(name).not.toBe('');
  const base = testProfile('source-a', [type]);
  const first = base.entityTypes[0];
  if (first === undefined) throw new Error('no entity type');
  return { profile: { ...base, entityTypes: [{ ...first, displayName: name }] }, type, name };
}

describe('the suggestions of the Assistant', () => {
  const packs = PACKS.map(packOf);

  it.each(PACKS.map((directory, index) => [directory, index] as const))('names the display name of the investigation entity type, then the two fixed questions, and nothing of the other pack (%s)', (_name, index) => {
    const pack = packs[index];
    const other = packs[1 - index];
    if (pack === undefined || other === undefined) throw new Error('no pack');
    const result = suggestionsOf(pack.profile, { entityType: pack.type, stableId: 'e1' });
    expect(result.map((entry) => entry.question)).toEqual([`What is connected to this ${pack.name}?`, 'Summarize what is on screen', 'Is anything useful in the data?']);
    expect(result.map((entry) => entry.question).join(' ')).not.toContain(other.name);
  });

  it('leaves out the first when the type has no entry in the profile, or there is no profile or no starting entity', () => {
    const pack = packs[0];
    if (pack === undefined) throw new Error('no pack');
    const fixedOnly = ['Summarize what is on screen', 'Is anything useful in the data?'];
    expect(suggestionsOf(pack.profile, { entityType: 'unlisted', stableId: 'x' }).map((entry) => entry.question)).toEqual(fixedOnly);
    expect(suggestionsOf(undefined, { entityType: pack.type, stableId: 'x' }).map((entry) => entry.question)).toEqual(fixedOnly);
    expect(suggestionsOf(pack.profile, null).map((entry) => entry.question)).toEqual(fixedOnly);
    expect(suggestionsOf(testProfile('source-a', ['other']), undefined).map((entry) => entry.question)).toEqual(fixedOnly);
  });

  it('drops the first when it is over the word limit and keeps the label equal to the question', () => {
    const pack = packs[0];
    if (pack === undefined) throw new Error('no pack');
    const start = { entityType: pack.type, stableId: 'e1' };
    expect(suggestionsOf(pack.profile, start, 2)).toHaveLength(2);
    for (const entry of suggestionsOf(pack.profile, start)) expect(entry.label).toBe(entry.question);
  });
});

describe('the source of the suggestions and of the intro note', () => {
  const read = (file: string): string => readFileSync(resolve(process.cwd(), 'src/assistant', file), 'utf8');
  const forbidden = (): RegExp[] => {
    const words = PACKS.flatMap((directory) => {
      const mapping = readFileSync(resolve(process.cwd(), '../../domain-packs', directory, 'neburyx.yaml'), 'utf8');
      return [...mapping.matchAll(/^\s+- type: (\S+)$/gm)].map((match) => match[1] ?? '');
    });
    return [...words.map((word) => new RegExp(`\\b${word}\\b`, 'iu')), /\bfraud\b/iu, /[A-Z]{2,}-\d{3,}/u];
  };

  it('holds no entity type name, fraud word or identifier-shaped literal', () => {
    const copy = read('copy.ts');
    const entries = ['introNote', 'forExample', 'introTitle', 'intro'].flatMap((key) => new RegExp(`^\\s+${key}:.*$`, 'mu').exec(copy)?.[0] ?? []);
    for (const text of [read('suggestions.ts'), ...entries]) for (const pattern of forbidden()) expect(pattern.test(text)).toBe(false);
  });
});
