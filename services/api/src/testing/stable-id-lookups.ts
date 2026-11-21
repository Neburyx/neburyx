import { patternParams, step } from './pattern-fixtures.js';

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
