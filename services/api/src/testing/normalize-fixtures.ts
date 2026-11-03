import type { SourceModel } from '../mapping/model.js';
import { mappingOf, sourceWith } from './gate-fixtures.js';
import { normalizeModelOf, type NormalizeContext } from '../gate/normalize/model.js';

/** A source with two entity types and one relationship, and the context a template is normalized with, for the rules that need records the packs do not hold. */
export const source = mappingOf(
  sourceWith('alpha', {
    entities: [
      { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', title: 'Gadget {title}', search: ['title'], filterable: ['kind'], display: { key_properties: ['kind', 'madeOn'] } },
      { type: 'person', label: 'Person', stable_id: 'personId' },
    ],
    relationships: [
      { type: 'MADE_BY', from: 'gadget', to: 'person', observed_at: 'madeAt' },
      { type: 'KNOWS', from: 'person', to: 'person', stable_id: 'linkId', observed_at: 'seenAt', evidence: ['recordId'] },
      { type: 'LIKES', from: 'person', to: 'person', stable_id: 'linkId' },
    ],
    derived: [{ id: 'shared-maker', from: 'gadget', to: 'gadget', via: ['MADE_BY', 'person', 'MADE_BY'], rule_version: 3, stop_list_property: 'sharedFlag' }],
  }),
).sources[0] as SourceModel;

export const context = (overrides: Partial<NormalizeContext> = {}): NormalizeContext => ({ sourceId: 'request-source', hasMore: false, model: normalizeModelOf(source), ...overrides });

let counter = 0;
const nextId = (prefix: string): string => `${prefix}${++counter}`;

export const plainNode = (labels: readonly string[], properties: Record<string, unknown>, elementId = nextId('n')) => ({ $type: 'node' as const, elementId, labels, properties });

export const plainRelationship = (type: string, from: { elementId: string }, to: { elementId: string }, properties: Record<string, unknown> = {}, elementId = nextId('r')) => ({
  $type: 'relationship' as const,
  elementId,
  type,
  startElementId: from.elementId,
  endElementId: to.elementId,
  properties,
});

/** Two entity types that share one label: a node with that label cannot be told apart. */
export const twinSource = mappingOf(
  sourceWith('alpha', {
    entities: [
      { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
      { type: 'twin', label: 'Gadget', stable_id: 'twinId' },
    ],
    relationships: [],
  }),
).sources[0] as SourceModel;
