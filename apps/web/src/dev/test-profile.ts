import type { SourceProfile } from '@neburyx/contracts';

const entity = (type: string) => ({ type, label: type.toUpperCase(), keyed: false, stableIdProperty: 'id', displayName: type.toUpperCase(), icon: 'generic' as const, title: 'name', titleUsesPii: false, keyProperties: [], stateProperty: null, searchable: [], filterable: [], sortable: [], pii: [], properties: [] });

export function testProfile(sourceId = 'source-a', types: readonly string[] = ['kind-a', 'kind-b', 'kind-c']): SourceProfile {
  const [first = 'kind-a', second = 'kind-b', third = 'kind-c'] = types;
  return {
    sourceId,
    synthetic: true,
    vocabulary: { caseRef: null },
    entityTypes: types.map(entity),
    relationshipTypes: [
      { type: 'link-a', from: first, to: second, aggregate: false, observedAt: null, filterable: [], sortable: [], evidence: [], properties: [], stableIdProperty: null },
      { type: 'link-b', from: second, to: third, aggregate: true, observedAt: null, filterable: [], sortable: [], evidence: [], properties: [], stableIdProperty: null },
    ],
    derivedRules: [{ id: 'rule-1', from: first, to: first, via: ['link-a'], ruleVersion: 1 }],
    presets: [],
    mappingExcerpt: '',
  };
}
