import type { SourceSummary } from '@neburyx/contracts';
import type { SourceRow } from '../db/sources-repository.js';
import type { MappingModel } from '../mapping/model.js';

export function summariesOf(rows: readonly SourceRow[], mapping: MappingModel): SourceSummary[] {
  return [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).flatMap((row) => {
    const source = mapping.sources.find((candidate) => candidate.id === row.id);
    if (source === undefined) return [];
    return [
      {
        id: row.id,
        alias: row.alias,
        state: row.state,
        stateReason: row.stateReason,
        readOnly: true,
        synthetic: row.synthetic,
        lastTestAt: null,
        mappingSummary: {
          entityTypes: source.entities.length,
          relationshipTypes: source.relationships.length,
          derivedRules: source.derived.length,
        },
      },
    ];
  });
}
