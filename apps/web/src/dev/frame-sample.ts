import type { EdgeRef, ElementRef, GraphEdge, GraphNode, IconKey, SourceProfile } from '@neburyx/contracts';
import { createClientState, type ClientState } from '../state/client-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, elementKey } from '../state/keys.js';
import { FIXTURE_RECORD } from './fixture-loader.js';

export const FRAME_SAMPLE_SOURCE = 'frame-sample';
const FRAME_SAMPLE_MARKER = 'neburyx-dev-frame-sample';

interface SampleEntity {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly state?: string;
  readonly at: { readonly x: number; readonly y: number };
}

const TYPES: ReadonlyArray<{ readonly type: string; readonly label: string; readonly icon: IconKey }> = [
  { type: 'ledger', label: 'Ledger', icon: 'money' },
  { type: 'holder', label: 'Holder', icon: 'person' },
  { type: 'casefile', label: 'Case file', icon: 'document' },
  { type: 'transfer', label: 'Transfer', icon: 'document' },
  { type: 'seller', label: 'Seller', icon: 'storefront' },
  { type: 'gadget', label: 'Gadget', icon: 'terminal' },
  { type: 'host', label: 'Network host', icon: 'network' },
  { type: 'line', label: 'Line', icon: 'telephone' },
];

/** The entities of the Explore design, each where the design puts the centre of its disc, with synthetic names and neutral type words. */
const ENTITIES: readonly SampleEntity[] = [
  { id: 'holder', type: 'holder', title: 'Jordan Lee', state: 'Synthetic', at: { x: 180, y: 430 } },
  { id: 'led-1', type: 'ledger', title: 'LED-48291', state: 'Review required', at: { x: 430, y: 430 } },
  { id: 'led-2', type: 'ledger', title: 'LED-71825', state: 'Live', at: { x: 700, y: 430 } },
  { id: 'cas', type: 'casefile', title: 'CAS-20348', state: 'Open', at: { x: 180, y: 200 } },
  { id: 'trn', type: 'transfer', title: 'TRN-99381', state: 'Done', at: { x: 430, y: 200 } },
  { id: 'sel', type: 'seller', title: 'SEL-231', at: { x: 650, y: 170 } },
  { id: 'gad-1', type: 'gadget', title: 'GAD-884', state: 'Browser fp', at: { x: 700, y: 270 } },
  { id: 'gad-2', type: 'gadget', title: 'GAD-217', at: { x: 700, y: 600 } },
  { id: 'hst', type: 'host', title: '198.51.100.42', at: { x: 960, y: 430 } },
  { id: 'lin', type: 'line', title: 'LIN-1042', state: 'Contact', at: { x: 180, y: 650 } },
];

/** One kind of each: sourced, rule-derived and aggregate; the relationships of the design, between the same entities. */
const RELATIONSHIPS: ReadonlyArray<readonly [string, string, string, 'stored' | 'derived' | 'aggregate']> = [
  ['holder', 'lin', 'HAS_LINE', 'stored'],
  ['holder', 'led-1', 'HOLDS', 'stored'],
  ['holder', 'cas', 'FILES', 'stored'],
  ['cas', 'trn', 'CONTESTS', 'stored'],
  ['led-1', 'trn', 'SENDS', 'stored'],
  ['trn', 'sel', 'PAYS', 'stored'],
  ['led-1', 'gad-1', 'USES_GADGET', 'aggregate'],
  ['led-2', 'gad-1', 'USES_GADGET', 'stored'],
  ['gad-1', 'hst', 'SEEN_AT', 'stored'],
  ['gad-2', 'hst', 'SEEN_AT', 'stored'],
  ['led-2', 'gad-2', 'USES_GADGET', 'stored'],
  ['led-1', 'gad-2', 'USES_GADGET', 'stored'],
  ['led-1', 'led-2', 'SHARED_GADGET', 'derived'],
];

const STATE_PROPERTY = 'status';

/** The sample's style rules, for `?rules=on`: each reads the state property, as the rules of a mapping read a mapped property. */
const SAMPLE_RULES: SourceProfile['styleRules'] = [
  { id: 'review-flag', label: 'review required', appliesTo: 'ledger', effect: { badge: 'amber' }, condition: 'status = Review required' },
  { id: 'live-ledger', label: 'live ledger', appliesTo: 'ledger', effect: { size: 'larger' }, condition: 'status = Live' },
  { id: 'open-case', label: 'open case', appliesTo: 'casefile', effect: { color: 'blue' }, condition: 'status = Open' },
  { id: 'contact-line', label: 'contact line', appliesTo: 'line', effect: { icon: 'shield' }, condition: 'status = Contact' },
];

const matchedRules = (entity: SampleEntity): string[] | undefined => {
  const ids = (SAMPLE_RULES ?? []).filter((rule) => rule.appliesTo === entity.type && rule.condition === `status = ${entity.state ?? ''}`).map((rule) => rule.id);
  return ids.length === 0 ? undefined : ids;
};

/** The relationship rows of the sample, each with a time property when `timed`: one row for each type with its two entity types. */
function sampleRelationshipRows(timed: boolean): SourceProfile['relationshipTypes'] {
  if (!timed) return [];
  const typeOf = (id: string): string => ENTITIES.find((entity) => entity.id === id)?.type ?? id;
  const rows = new Map<string, SourceProfile['relationshipTypes'][number]>();
  for (const [from, to, type, kind] of RELATIONSHIPS) {
    if (kind === 'derived') continue;
    rows.set(`${type}|${typeOf(from)}|${typeOf(to)}`, { type, from: typeOf(from), to: typeOf(to), aggregate: kind === 'aggregate', observedAt: 'seenAt', stableIdProperty: kind === 'aggregate' ? null : 'id', filterable: [], sortable: [], evidence: [], properties: [] });
  }
  return [...rows.values()];
}

export function frameSampleProfile(timed = false, rules = false): SourceProfile {
  const entityTypes = TYPES.map((entry) => ({ type: entry.type, label: entry.label, keyed: false, stableIdProperty: 'id', displayName: entry.label, icon: entry.icon, title: 'name', titleUsesPii: false, keyProperties: [], stateProperty: STATE_PROPERTY, searchable: [], filterable: [STATE_PROPERTY], sortable: [STATE_PROPERTY], pii: [], properties: [STATE_PROPERTY] }));
  return {
    sourceId: FRAME_SAMPLE_SOURCE,
    synthetic: true,
    vocabulary: { caseRef: null },
    entityTypes,
    relationshipTypes: sampleRelationshipRows(timed),
    derivedRules: [],
    presets: [],
    ...(rules ? { styleRules: SAMPLE_RULES } : {}),
    mappingExcerpt: FRAME_SAMPLE_MARKER,
  };
}

/** A client state holding the Explore design's graph, every entity placed where the design draws it, so the canvas can be put beside the design. */
/** With `timed`, the stored relationships carry a time: those at an even position in October 2026 and the others in January 2026. */
export function createFrameSampleState(timed = false, rules = false): ClientState {
  const state = createClientState();
  const refOf = (id: string): ElementRef => {
    const entity = ENTITIES.find((candidate) => candidate.id === id);
    if (entity === undefined) throw new Error(`the sample has no entity ${id}`);
    return { sourceId: FRAME_SAMPLE_SOURCE, entityType: entity.type, stableId: entity.id };
  };
  const nodes: GraphNode[] = ENTITIES.map((entity) => ({
    ref: refOf(entity.id),
    display: { title: entity.title, type: entity.type, ...(rules && matchedRules(entity) !== undefined ? { styleRules: matchedRules(entity) } : {}) },
    properties: entity.state === undefined ? [] : [{ key: STATE_PROPERTY, value: entity.state, dataClass: 'text' as const, masked: false }],
    qualityFlags: [],
    provenanceRefs: [FRAME_SAMPLE_MARKER],
    authorization: { canInspect: true, canExport: true },
  }));
  const edges: GraphEdge[] = RELATIONSHIPS.map(([from, to, type, kind], index) => {
    const fromRef = refOf(from);
    const toRef = refOf(to);
    const common = { from: fromRef, to: toRef, type, direction: 'from-to' as const, properties: [], evidenceRefs: [], qualityFlags: [] };
    if (kind === 'aggregate') return { ...common, ref: { sourceId: FRAME_SAMPLE_SOURCE, aggregate: { type, from: fromRef, to: toRef } }, semantics: 'stored' as const, memberCount: { value: 42, quality: 'exact' as const, scope: 'members of this relationship type between the two entities' } };
    if (kind === 'derived') return { ...common, ref: { sourceId: FRAME_SAMPLE_SOURCE, derived: { ruleId: type, from: fromRef, to: toRef } }, semantics: 'derived' as const, derivation: { ruleId: type, ruleVersion: 1, supportingEdgeRefs: [] } };
    return { ...common, ref: { sourceId: FRAME_SAMPLE_SOURCE, type, from: fromRef.entityType, to: toRef.entityType, stableId: `sample-r-${index}` }, semantics: 'stored' as const, ...(timed ? { observedAt: index % 2 === 0 ? '2026-10-15T10:00:00Z' : '2026-01-15T10:00:00Z' } : {}) };
  });
  const key = { sourceId: FRAME_SAMPLE_SOURCE, principalId: 'frame-sample', policyVersion: DEFAULT_POLICY_VERSION, filterHash: DEFAULT_FILTER_HASH, params: FRAME_SAMPLE_MARKER, mask: false };
  state.bindSource(FRAME_SAMPLE_SOURCE);
  state.putResult(key, { sourceId: FRAME_SAMPLE_SOURCE, nodes, edges });
  state.setLoaded([key], nodes.map((node) => node.ref), edges.map((edge): EdgeRef => edge.ref));
  for (const entity of ENTITIES) state.presentation.setPosition(elementKey(refOf(entity.id)), entity.at);
  // the frames draw no mark for a pin, so this changes nothing in the picture; it lets a drag of a pinned entity be tried on the sample
  state.replacePins([elementKey(refOf('gad-2'))]);
  state.describeInvestigation(FIXTURE_RECORD);
  return state;
}
