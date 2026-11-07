import { describe, expect, it } from 'vitest';
import { firstSource, load, baseSource } from '../testing/mapping.js';
import { mappingSummaryOf } from './summary.js';

describe('the mapping summary and keyed types', () => {
  it('counts the entity types whose stable ID is also personal data, and says nothing when there is none', () => {
    const plain = firstSource(load(baseSource({ entities: [{ type: 'node_a', label: 'A', stable_id: 'id' }], relationships: undefined })));
    expect(mappingSummaryOf(plain)).toEqual({ entityTypes: 1, relationshipTypes: 0, derivedRules: 0 });
    const keyed = firstSource(load(baseSource({ entities: [{ type: 'node_a', label: 'A', stable_id: 'id', pii: ['id'] }, { type: 'node_b', label: 'B', stable_id: 'key' }], relationships: undefined })));
    expect(mappingSummaryOf(keyed)).toEqual({ entityTypes: 2, relationshipTypes: 0, derivedRules: 0, keyedEntityTypes: 1 });
  });
});
