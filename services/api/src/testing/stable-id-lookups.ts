import { allowlistFromMapping } from '../gate/allowlist.js';
import { DERIVED_RULE } from './derived-fixtures.js';
import { linkedMappingOf } from './linked-entities-fixtures.js';
import { PATTERN_ENTITIES, PATTERN_RELATIONSHIPS, patternParams, step } from './pattern-fixtures.js';

const end = (stableId: string, entityType = 'maker') => ({ sourceId: 'demo', entityType, stableId });
const ref = (stableId: string, entityType = 'maker') => end(stableId, entityType);

/** The templates that find an element by its stable ID, each with parameters the fixture mapping accepts. */
export const LOOKUP_INVENTORY: Record<string, Record<string, unknown>> = {
  'entity-load': { entityType: 'maker', stableId: 'A-1' },
  'entity-load-many': { entityType: 'maker', refs: [ref('A-1'), ref('A-2')] },
  'edge-load': { type: 'LINKS', from: 'maker', to: 'maker', stableId: 'L-1' },
  'edge-load-many': { type: 'LINKS', from: 'maker', to: 'maker', refs: [{ stableId: 'L-1' }, { stableId: 'L-2' }] },
  'degree-preview-bounded': { entityType: 'maker', stableId: 'A-1' },
  'degree-preview-cheap': { entityType: 'maker', stableId: 'A-1' },
  'expand-neighbors': { entityType: 'maker', stableId: 'A-1', neighborType: 'maker', direction: 'both', sort: 'observed' },
  'expand-count': { entityType: 'maker', stableId: 'A-1', neighborType: 'maker', direction: 'both', windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-02-01T00:00:00Z' },
  'shared-attribute': { entityType: 'maker', stableId: 'A-1', attributeType: 'tool', via: 'USES_TOOL' },
  'shared-attribute-count': { entityType: 'maker', stableId: 'A-1', attributeType: 'tool', via: 'USES_TOOL' },
  'linked-entities': { entityType: 'maker', stableId: 'A-1', targetType: 'maker', via: ['LINKS'], direction: 'out' },
  'linked-entities-count': { entityType: 'maker', stableId: 'A-1', targetType: 'maker', via: ['LINKS'], direction: 'out' },
  pattern: patternParams([step()]),
  'pattern-count': patternParams([step()]),
  'shortest-paths': { ends: [end('A-1'), end('A-2')], via: ['LINKS'], maxHops: 3 },
  'shortest-paths-count': { ends: [end('A-1'), end('A-2')], via: ['LINKS'], maxHops: 3 },
  'derived-rule-run': { entityType: 'maker', stableId: 'A-1', ruleId: 'shared-tool' },
  'derived-edge-support': { ruleId: 'shared-tool', ends: [end('A-1'), end('A-2')] },
  'aggregate-sample': { type: 'USES_TOOL', ends: [end('A-1'), end('D-1', 'tool')] },
  'aggregate-summary': { type: 'USES_TOOL', ends: [end('A-1'), end('D-1', 'tool')] },
  'entity-related-context': { hits: [ref('A-1')], exact: [ref('A-2')] },
};

/**
 * The mapping the shapes below are written for: the pattern fixtures' entity and relationship types, a rank the maker type can be sorted by, an observed time on the tool relationship, a search property on the maker
 * type and an evidence property on the link relationship.
 */
export const LOOKUP_MAPPING = linkedMappingOf({
  entities: PATTERN_ENTITIES.map((entity) => (entity.type === 'maker' ? { ...entity, sortable: ['rank'], search: ['region'] } : entity.type === 'tool' ? { ...entity, reference: ['kind'] } : entity)),
  relationships: PATTERN_RELATIONSHIPS.map((row) => (row.type === 'USES_TOOL' ? { ...row, observed_at: 'seenAt' } : row.type === 'LINKS' ? { ...row, evidence: ['lane'] } : row)),
  derived: [DERIVED_RULE],
  patterns: [],
});
const [lookupSource] = LOOKUP_MAPPING.sources;
if (lookupSource === undefined) throw new Error('the mapping has no source');
export const LOOKUP_ALLOWLIST = allowlistFromMapping(lookupSource);

const WINDOW = { windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-12-31T00:00:00Z' };
const regionIs = { on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'north' } };
const rankBetween = { on: 'neighbor', property: 'rank', op: 'between', from: { kind: 'number', value: 2 }, to: { kind: 'number', value: 9 } };
const laneIs = { on: 'relationship', property: 'lane', op: 'eq', value: { kind: 'text', value: 'x' } };
const EXPAND = { entityType: 'maker', stableId: 'A-1', neighborType: 'maker', direction: 'both', sort: 'observed' };
const COUNT = { entityType: 'maker', stableId: 'A-1', neighborType: 'maker', direction: 'both' };
const ENDS = [end('A-1'), end('A-2')];
const LINK_TARGET = { relationshipType: 'LINKS', from: 'maker', to: 'maker', property: 'lane', match: 'value' };

/**
 * The shapes that add conditions, windows, filters, ranks, stop-lists and searches to the inventory above, each as `[name, template, parameters]`: the conditions of a match that has an anchor are in them, so the check of the
 * property reads and the oracle of the Neo4j tests render the same statements. A derived rule and a shared attribute carry the stop-list of the fixture's rule (`isCommon`) in the inventory's own entries.
 */
export const LOOKUP_SHAPES: readonly (readonly [string, string, Record<string, unknown>])[] = [
  ['expand out', 'expand-neighbors', { ...EXPAND, direction: 'out' }],
  ['expand in', 'expand-neighbors', { ...EXPAND, direction: 'in' }],
  ['expand to the other type', 'expand-neighbors', { ...EXPAND, neighborType: 'tool' }],
  ['expand windowed', 'expand-neighbors', { ...EXPAND, ...WINDOW }],
  ['expand filtered by a neighbor value', 'expand-neighbors', { ...EXPAND, filters: [regionIs] }],
  ['expand filtered by a neighbor range', 'expand-neighbors', { ...EXPAND, filters: [rankBetween] }],
  ['expand filtered by a relationship value', 'expand-neighbors', { ...EXPAND, relTypes: ['LINKS'], filters: [laneIs] }],
  ['expand ranked by the neighbor, descending', 'expand-neighbors', { ...EXPAND, rank: { on: 'neighbor', property: 'rank', order: 'desc' } }],
  ['expand ranked by the observed time, ascending', 'expand-neighbors', { ...EXPAND, relTypes: ['LINKS'], rank: { on: 'relationship', property: 'seenAt', order: 'asc' } }],
  ['expand count windowed', 'expand-count', { ...COUNT, ...WINDOW }],
  ['expand count filtered', 'expand-count', { ...COUNT, filters: [regionIs] }],
  ['aggregate sample of a type with an ID', 'aggregate-sample', { type: 'LINKS', ends: ENDS }],
  ['aggregate summary of a type with an ID', 'aggregate-summary', { type: 'LINKS', ends: ENDS }],
  ['aggregate summary of the pair with no ID on a member', 'aggregate-summary', { type: 'USES_TOOL', ends: [end('A-1'), end('D-1', 'tool')] }],
  ['pattern with a neighbor condition', 'pattern', patternParams([step({ conditions: [regionIs] })])],
  ['pattern with a relationship condition', 'pattern', patternParams([step({ conditions: [laneIs] })])],
  ['pattern with a window', 'pattern', patternParams([step({ ...WINDOW })])],
  ['pattern count with a neighbor condition', 'pattern-count', patternParams([step({ conditions: [regionIs] })])],
  ['shared attribute with a window', 'shared-attribute', { ...LOOKUP_INVENTORY['shared-attribute'], ...WINDOW }],
  ['linked entities with a window', 'linked-entities', { ...LOOKUP_INVENTORY['linked-entities'], ...WINDOW }],
];

/** The node search and evidence statements: they have no anchor and read properties on purpose (the check of the property reads leaves them out), and the oracle of the Neo4j tests runs them as it runs the others. */
export const LOOKUP_SEARCHES: readonly (readonly [string, string, Record<string, unknown>])[] = [
  ['entity search by value', 'entity-search', { text: 'north', targets: [{ entityType: 'maker', property: 'region', match: 'value' }] }],
  ['entity search by prefix', 'entity-search-prefix', { text: 'nor', targets: [{ entityType: 'maker', property: 'region', match: 'value' }] }],
  ['relationship evidence by value', 'relationship-evidence', { text: 'x', targets: [LINK_TARGET] }],
  ['related records by a reference property', 'entity-related', { text: 'plain', targets: [{ entityType: 'tool', property: 'kind', match: 'value' }] }],
  [
    'facets of a search property, a reference property and an evidence property',
    'search-facets',
    {
      text: 'north',
      probes: [
        { targets: [{ kind: 'search', entityType: 'maker', property: 'region', match: 'value' }] },
        { targets: [{ kind: 'reference', entityType: 'tool', property: 'kind', match: 'value' }] },
        { targets: [{ kind: 'evidence', relationshipType: 'LINKS', from: 'maker', to: 'maker', property: 'lane', match: 'value' }] },
      ],
    },
  ],
];
