import { describe, expect, it } from 'vitest';
import { createLiveMapping } from '../mapping/live.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { sourceStateOf } from './investigation-service.js';
import type { InvestigationRow } from '../db/investigations-repository.js';

const mappingOf = (...sources: Record<string, unknown>[]) => parseMapping(fileOf(...sources), 'mapping.yaml');
const entities = (extra: object[]) => [...(baseSource()['entities'] as object[]), ...extra];

describe('an investigation judged against a mapping that a dev reload replaces', () => {
  const initial = mappingOf(baseSource());
  const source = initial.sources[0];
  if (source === undefined) throw new Error('no source');
  const row = { sourceId: 'demo', sourceIdentityHash: identityHashOf(source) } as InvestigationRow;

  it('is available while the source keeps its connection, whatever else about it an edit changes, and its configHash follows the edit for the view rule', () => {
    const live = createLiveMapping(initial);
    expect(sourceStateOf(live, row)).toBe('available');
    const before = live.sources[0]?.configHash;
    live.replace(mappingOf(baseSource({ entities: entities([{ type: 'node_c', label: 'NodeC', stable_id: 'ref' }]), budgets: { max_page: 20 } })));
    expect(sourceStateOf(live, row)).toBe('available');
    expect(live.sources[0]?.configHash).not.toBe(before);
  });

  it('is removed once an edit removes its source, as after a restart', () => {
    const live = createLiveMapping(initial);
    live.replace(mappingOf(baseSource({ id: 'second' })));
    expect(sourceStateOf(live, row)).toBe('removed');
  });

  it('is repointed when the mapping holds another address for the source, as after a restart (a reload refuses that change, so this is the state a restart gives)', () => {
    const live = createLiveMapping(initial);
    live.replace(mappingOf(baseSource({ uri: 'neo4j+s://other.example.test:7687' })));
    expect(sourceStateOf(live, row)).toBe('repointed');
  });
});
