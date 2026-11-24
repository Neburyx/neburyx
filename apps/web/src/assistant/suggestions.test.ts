import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GraphNode, SourceProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { testProfile } from '../dev/test-profile.js';
import { NOT_READ_FLAG, UNMAPPED_FLAG } from '../draft/unmapped.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { node } from '../state/test-data.js';
import { SUGGESTION_TITLE_MAX, suggestionsOf } from './suggestions.js';

const PACKS = ['banking-fraud', 'insurance-claims'] as const;

interface Pack {
  readonly profile: SourceProfile;
  readonly type: string;
  readonly name: string;
  readonly title: string;
}

function packOf(directory: string, title: string): Pack {
  const mapping = readFileSync(resolve(process.cwd(), '../../domain-packs', directory, 'neburyx.yaml'), 'utf8');
  const type = /^\s+- type: (\S+)$/m.exec(mapping)?.[1] ?? '';
  const name = /^\s+label: (\S+)$/m.exec(mapping)?.[1] ?? '';
  expect(type).not.toBe('');
  expect(name).not.toBe('');
  const base = testProfile('source-a', [type]);
  const first = base.entityTypes[0];
  if (first === undefined) throw new Error('no entity type');
  return { profile: { ...base, entityTypes: [{ ...first, displayName: name }] }, type, name, title };
}

const graphOf = (nodes: readonly GraphNode[]): LoadedGraph => ({ nodes, edges: [], entities: { value: nodes.length, quality: 'exact', scope: 's' }, relationships: { value: 0, quality: 'exact', scope: 's' } });
const shown = (pack: Pack, stableId: string, title: string, flags: readonly string[] = []): GraphNode => ({ ...node('source-a', stableId), ref: { sourceId: 'source-a', entityType: pack.type, stableId }, display: { title, type: pack.type }, qualityFlags: [...flags] });

describe('the suggestions of the Assistant', () => {
  const packs = PACKS.map((directory, index) => packOf(directory, `Title of pack ${index + 1}`));

  it.each(packs.map((pack, index) => [PACKS[index], pack] as const))('builds the third from the entity on screen and carries nothing of the other pack (%s)', (_name, pack) => {
    const other = packs.find((held) => held !== pack);
    if (other === undefined) throw new Error('no other pack');
    const result = suggestionsOf(graphOf([shown(pack, 'e1', pack.title)]), pack.profile, { entityType: pack.type, stableId: 'e1' });
    expect(result.map((entry) => entry.question)).toEqual(['What am I looking at?', 'Summarize what is on screen', `What is connected to ${pack.title}?`]);
    const text = result.map((entry) => entry.question).join(' ');
    expect(text).not.toContain(other.title);
    expect(text).not.toContain(other.name);
  });

  it.each(packs.map((pack, index) => [PACKS[index], pack] as const))('names the display name of the investigation entity type when nothing usable is shown (%s)', (_name, pack) => {
    const result = suggestionsOf(graphOf([]), pack.profile, { entityType: pack.type, stableId: 'e1' });
    expect(result.at(-1)?.question).toBe(`What can I ask about this ${pack.name}?`);
    expect(result).toHaveLength(3);
  });

  it('shows two suggestions when nothing usable is shown and the entity has no type in the profile', () => {
    expect(suggestionsOf(graphOf([]), undefined, null)).toHaveLength(2);
    expect(suggestionsOf(graphOf([]), testProfile('source-a', ['other']), { entityType: 'unlisted', stableId: 'x' })).toHaveLength(2);
  });

  it('prefers the investigation own entity, else the first shown in draw order', () => {
    const pack = packs[0];
    if (pack === undefined) throw new Error('no pack');
    const graph = graphOf([shown(pack, 'e1', 'First'), shown(pack, 'e2', 'Second')]);
    expect(suggestionsOf(graph, pack.profile, { entityType: pack.type, stableId: 'e2' }).at(-1)?.question).toBe('What is connected to Second?');
    expect(suggestionsOf(graph, pack.profile, { entityType: pack.type, stableId: 'gone' }).at(-1)?.question).toBe('What is connected to First?');
  });

  it('skips entities that are not read and unmapped items', () => {
    const pack = packs[0];
    if (pack === undefined) throw new Error('no pack');
    const graph = graphOf([shown(pack, 'e1', 'Unmapped item', [UNMAPPED_FLAG]), shown(pack, 'e2', 'Not read', [NOT_READ_FLAG])]);
    expect(suggestionsOf(graph, pack.profile, { entityType: pack.type, stableId: 'e1' }).at(-1)?.question).toBe(`What can I ask about this ${pack.name}?`);
    expect(suggestionsOf(graphOf([...graph.nodes, shown(pack, 'e3', 'Real')]), pack.profile, null).at(-1)?.question).toBe('What is connected to Real?');
  });

  it('cuts a long title for the label and keeps it whole in the question, and drops it when the question is over the word limit', () => {
    const pack = packs[0];
    if (pack === undefined) throw new Error('no pack');
    const long = 'x'.repeat(SUGGESTION_TITLE_MAX + 20);
    const third = suggestionsOf(graphOf([shown(pack, 'e1', long)]), pack.profile, null).at(-1);
    expect(third?.question).toBe(`What is connected to ${long}?`);
    expect(third?.label).toBe(`What is connected to ${'x'.repeat(SUGGESTION_TITLE_MAX - 1)}…?`);
    const wordy = Array.from({ length: 30 }, (_, index) => `w${index}`).join(' ');
    const fallback = suggestionsOf(graphOf([shown(pack, 'e1', wordy)]), pack.profile, { entityType: pack.type, stableId: 'e1' }, 10);
    expect(fallback.at(-1)?.question).toBe(`What can I ask about this ${pack.name}?`);
    expect(suggestionsOf(graphOf([shown(pack, 'e1', wordy)]), undefined, null, 10)).toHaveLength(2);
  });

  it('keeps a title with quote marks or markup as plain text, unchanged', () => {
    const pack = packs[0];
    if (pack === undefined) throw new Error('no pack');
    const title = 'A "quoted" <b>title</b>';
    expect(suggestionsOf(graphOf([shown(pack, 'e1', title)]), pack.profile, null).at(-1)).toEqual({ label: `What is connected to ${title}?`, question: `What is connected to ${title}?` });
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
    const entries = ['examples', 'introNote', 'forExample', 'introTitle', 'intro'].flatMap((key) => new RegExp(`^\\s+${key}:.*$`, 'mu').exec(copy)?.[0] ?? []);
    for (const text of [read('suggestions.ts'), ...entries]) for (const pattern of forbidden()) expect(pattern.test(text)).toBe(false);
  });
});
