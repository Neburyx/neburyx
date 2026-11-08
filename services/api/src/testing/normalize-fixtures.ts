import { mappingOf, sourceWith } from './gate-fixtures.js';
import { normalizeModelOf, type NormalizeContext, type NormalizeModel } from '../gate/normalize/model.js';
import { DEFAULT_BUDGETS } from '../gate/budgets.js';
import type { GateContext } from '../gate/types.js';
import { EMPTY_ALLOWLIST, LOCAL_PRINCIPAL } from './gate.js';

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
).sources[0] ?? failNoSource();

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

/** One relationship type mapped between two pairs of entity types with one stable ID key, for the references that must stay apart. */
export const pairedSource = mappingOf(
  sourceWith('alpha', {
    entities: [
      { type: 'person', label: 'Person', stable_id: 'personId' },
      { type: 'org', label: 'Org', stable_id: 'orgId' },
    ],
    relationships: [
      { type: 'KNOWS', from: 'person', to: 'person', stable_id: 'linkId' },
      { type: 'KNOWS', from: 'person', to: 'org', stable_id: 'linkId' },
    ],
  }),
).sources[0] ?? failNoSource();

/** Two entity types that share one label: a node with that label cannot be told apart. */
export const twinSource = mappingOf(
  sourceWith('alpha', {
    entities: [
      { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
      { type: 'twin', label: 'Gadget', stable_id: 'twinId' },
    ],
    relationships: [],
  }),
).sources[0] ?? failNoSource();

/** The part of a gate context the redact stage reads: the source's model and whether the request asks for masking. */
export const redactContext = (model: NormalizeModel, mask: boolean): GateContext => ({
  traceId: 'tr-test',
  principal: LOCAL_PRINCIPAL,
  system: false,
  role: 'data',
  sourceId: 'alpha',
  budgets: DEFAULT_BUDGETS,
  allowlist: EMPTY_ALLOWLIST,
  policyVersion: 'none',
  mask,
  model,
  deadlineAt: 0,
});

function failNoSource(): never {
  throw new Error('the mapping holds no source');
}
