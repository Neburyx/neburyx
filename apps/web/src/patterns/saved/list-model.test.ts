import { describe, expect, it } from 'vitest';
import type { ListedPattern } from '@neburyx/contracts';
import { presetSummary, rowMatches, savedSummary } from './list-model.js';

const names: Record<string, string> = { 'kind-a': 'Kind A', 'kind-b': 'Kind B' };
const nameOf = (type: string): string => names[type] ?? type;
const preset = (bind: Record<string, string>) => ({ bind });

describe('the chain of a built-in pattern in a line', () => {
  it('reads the start type, the relationship type and the type reached from the binding, and the start type again for a binding that reaches no other', () => {
    expect(presetSummary(preset({ anchor: 'kind-a', attribute: 'kind-b', via: 'USES' }), nameOf)).toBe('Kind A → USES → Kind B');
    expect(presetSummary(preset({ anchor: 'kind-a', target: 'kind-b', via: 'PAYS' }), nameOf)).toBe('Kind A → PAYS → Kind B');
    expect(presetSummary(preset({ anchor: 'kind-a', via: 'PAYS' }), nameOf)).toBe('Kind A → PAYS → Kind A');
    expect(presetSummary(preset({}), nameOf)).toBe('');
  });
});

describe('the chain of a saved pattern in a line', () => {
  const definition = { anchorType: 'kind-a', steps: [{ relationshipTypes: ['USES'], direction: 'out', arrivesAt: 'kind-b' }] };
  const saved = (over: Record<string, unknown>) => ({ id: 'i', name: 'n', ownedByYou: true, ...over }) as unknown as ListedPattern;

  it('is the path of a stored definition, and nothing for a definition the product does not read', () => {
    expect(savedSummary(saved({ kind: 'definition', definition }), undefined, nameOf)).toBe('Kind A → USES → Kind B');
    expect(savedSummary(saved({ kind: 'definition', definition: { anchorType: 'kind-a' } }), undefined, nameOf)).toBe('');
  });

  it('is the chain of the built-in pattern a saved run came from, and nothing when that pattern is gone', () => {
    const presets = [{ id: 'p', name: 'P', template: 'shared-attribute' as const, bind: { anchor: 'kind-a', attribute: 'kind-b', via: 'USES' }, labels: [] }];
    expect(savedSummary(saved({ kind: 'preset-run', presetId: 'p' }), presets, nameOf)).toBe('Kind A → USES → Kind B');
    expect(savedSummary(saved({ kind: 'preset-run', presetId: 'gone' }), presets, nameOf)).toBe('');
  });
});

describe('the search of the list', () => {
  it('matches the name or the chain, ignoring case and spaces at the ends, and shows every row for no text', () => {
    expect(rowMatches('', 'Alpha', 'Kind A → USES → Kind B')).toBe(true);
    expect(rowMatches('  ALP ', 'Alpha', '')).toBe(true);
    expect(rowMatches('uses', 'Alpha', 'Kind A → USES → Kind B')).toBe(true);
    expect(rowMatches('zzz', 'Alpha', 'Kind A → USES → Kind B')).toBe(false);
  });
});
