import type { ElementRef, GraphEdge, GraphNode, SourceProfile } from '@neburyx/contracts';
import { edgeKey } from '../state/keys.js';
import { createRandom, pickIndex, type Random } from './random.js';

export const GENERATOR_MARKER = 'neburyx-dev-fixture-generator';
export const FIXTURE_ELEMENTS = 300;
export const FIXTURE_PINS = 10;

const NODE_SHARE = 0.4;
const DERIVED_SHARE = 0.12;
const ATTEMPTS = 40;
const SYNTHETIC_STATES = ['Open', 'Review required', 'Closed'] as const;

export const FIXTURE_ERROR_CODES = ['NO_ENTITY_TYPES', 'NO_RELATIONSHIP_TYPES', 'PROFILE_TOO_SMALL'] as const;

export class FixtureError extends Error {
  readonly code: (typeof FIXTURE_ERROR_CODES)[number];

  constructor(code: (typeof FIXTURE_ERROR_CODES)[number]) {
    super(code);
    this.name = 'FixtureError';
    this.code = code;
  }
}

export interface FixtureGraph {
  readonly sourceId: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly pins: readonly ElementRef[];
}

function nodeAt(profile: SourceProfile, type: string, label: string, stateProperty: string | null, index: number): GraphNode {
  const stableId = `fixture-${String(index).padStart(4, '0')}`;
  const state = SYNTHETIC_STATES[Math.floor(index / Math.max(1, profile.entityTypes.length)) % SYNTHETIC_STATES.length];
  return {
    ref: { sourceId: profile.sourceId, entityType: type, stableId },
    display: { title: `${label} ${stableId}`, type },
    properties: stateProperty === null || state === undefined ? [] : [{ key: stateProperty, value: state, dataClass: 'text', masked: false }],
    qualityFlags: [],
    provenanceRefs: [GENERATOR_MARKER],
    authorization: { canInspect: true, canExport: true },
  };
}

function pick<T>(items: readonly T[], random: Random): T | undefined {
  return items[pickIndex(random, items.length)];
}

/** Exactly 300 drawn elements (120 nodes and 180 relationships) from the profile's types and rules, or a named refusal; the same profile and seed give the same graph. */
export function generateFixtureGraph(profile: SourceProfile, seed: number): FixtureGraph {
  if (profile.entityTypes.length === 0) throw new FixtureError('NO_ENTITY_TYPES');
  const random = createRandom(seed);
  const nodeTotal = Math.round(FIXTURE_ELEMENTS * NODE_SHARE);
  const edgeTotal = FIXTURE_ELEMENTS - nodeTotal;
  const nodes: GraphNode[] = [];
  for (let index = 0; index < nodeTotal; index += 1) {
    const entityType = profile.entityTypes[index % profile.entityTypes.length];
    if (entityType !== undefined) nodes.push(nodeAt(profile, entityType.type, entityType.label, entityType.stateProperty, index));
  }
  const ofType = (type: string): readonly GraphNode[] => nodes.filter((node) => node.ref.entityType === type);
  const usable = (from: string, to: string): boolean => ofType(from).length > 0 && ofType(to).length > 0 && (from !== to || ofType(from).length > 1);
  const relationshipTypes = profile.relationshipTypes.filter((relationship) => usable(relationship.from, relationship.to));
  if (relationshipTypes.length === 0) throw new FixtureError('NO_RELATIONSHIP_TYPES');
  const rules = profile.derivedRules.filter((rule) => usable(rule.from, rule.to));

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const base = () => ({ direction: 'from-to' as const, properties: [], evidenceRefs: [], qualityFlags: [] });
  const add = (edge: GraphEdge): boolean => {
    const key = edgeKey(edge.ref);
    if (seen.has(key)) return false;
    seen.add(key);
    edges.push(edge);
    return true;
  };

  const derivedBudget = rules.length === 0 ? 0 : Math.round(edgeTotal * DERIVED_SHARE);
  for (let attempt = 0; attempt < derivedBudget * ATTEMPTS && edges.length < derivedBudget; attempt += 1) {
    const rule = rules[attempt % rules.length];
    const from = rule === undefined ? undefined : pick(ofType(rule.from), random);
    const to = rule === undefined ? undefined : pick(ofType(rule.to), random);
    if (rule === undefined || from === undefined || to === undefined || from === to) continue;
    add({ ...base(), ref: { sourceId: profile.sourceId, derived: { ruleId: rule.id, from: from.ref, to: to.ref } }, from: from.ref, to: to.ref, type: rule.id, semantics: 'derived', derivation: { ruleId: rule.id, ruleVersion: rule.ruleVersion, supportingEdgeRefs: [] } });
  }

  const stored = relationshipTypes.filter((relationship) => !relationship.aggregate);
  const fallback = stored.length > 0 ? stored : relationshipTypes;
  for (let attempt = 0; attempt < edgeTotal * ATTEMPTS && edges.length < edgeTotal; attempt += 1) {
    const relationship = pick(attempt < edgeTotal * 2 ? relationshipTypes : fallback, random);
    const from = relationship === undefined ? undefined : pick(ofType(relationship.from), random);
    const to = relationship === undefined ? undefined : pick(ofType(relationship.to), random);
    if (relationship === undefined || from === undefined || to === undefined || from === to) continue;
    if (relationship.aggregate) {
      add({ ...base(), ref: { sourceId: profile.sourceId, aggregate: { type: relationship.type, from: from.ref, to: to.ref } }, from: from.ref, to: to.ref, type: relationship.type, semantics: 'stored', memberCount: { value: 2 + pickIndex(random, 40), quality: 'exact', scope: 'members of this relationship type between the two entities' } });
    } else {
      add({ ...base(), ref: { sourceId: profile.sourceId, stableId: `fixture-r-${String(edges.length).padStart(4, '0')}-${attempt}` }, from: from.ref, to: to.ref, type: relationship.type, semantics: 'stored' });
    }
  }
  if (edges.length !== edgeTotal) throw new FixtureError('PROFILE_TOO_SMALL');

  const order = nodes.map((node) => node.ref);
  const pins: ElementRef[] = [];
  for (let index = order.length - 1; index > 0 && pins.length < FIXTURE_PINS; index -= 1) {
    const other = pickIndex(random, index + 1);
    const held = order[index];
    const swap = order[other];
    if (held !== undefined && swap !== undefined) {
      order[index] = swap;
      order[other] = held;
      pins.push(swap);
    }
  }
  return { sourceId: profile.sourceId, nodes, edges, pins };
}

export interface FixtureAddition {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** `count` more entities, each joined by one stored relationship to an entity that is already there (or, every fifth, to the one before it when its type fits), the relationship being one of the profile's whose two ends are of the types the two entities are; an entity type that no stored relationship can join to a loaded entity is passed over, and none that can is a refusal before anything is made. The same profile, number and entities give the same addition. */
export function generateAddition(profile: SourceProfile, existing: readonly GraphNode[], count: number, round: number): FixtureAddition {
  if (profile.entityTypes.length === 0) throw new FixtureError('NO_ENTITY_TYPES');
  const random = createRandom(round * 7919 + 1);
  const stored = profile.relationshipTypes.filter((relationship) => !relationship.aggregate);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const holding = (type: string, except: string): readonly GraphNode[] => [...existing, ...nodes].filter((node) => node.ref.entityType === type && node.ref.stableId !== except);
  const optionsFor = (type: string, except: string) =>
    stored.flatMap((relationship) => [
      ...(relationship.from === type ? [{ relationship, forward: true, partnerType: relationship.to }] : []),
      ...(relationship.to === type ? [{ relationship, forward: false, partnerType: relationship.from }] : []),
    ]).flatMap((option) => {
      const partners = holding(option.partnerType, except);
      return partners.length === 0 ? [] : [{ ...option, partners }];
    });
  for (let index = 0; index < count; index += 1) {
    const number = existing.length + round * count + index;
    const candidates = profile.entityTypes.map((_unused, step) => profile.entityTypes[(index + step) % profile.entityTypes.length]);
    const chosen = candidates.flatMap((entityType) => {
      if (entityType === undefined) return [];
      const added = nodeAt(profile, entityType.type, entityType.label, entityType.stateProperty, number);
      const options = optionsFor(entityType.type, added.ref.stableId);
      return options.length === 0 ? [] : [{ entityType, added, options }];
    })[0];
    if (chosen === undefined) throw new FixtureError('NO_RELATIONSHIP_TYPES');
    const option = pick(chosen.options, random);
    const previous = nodes[nodes.length - 1];
    const partner = option !== undefined && index % 5 === 4 && previous !== undefined && previous.ref.entityType === option.partnerType ? previous : option === undefined ? undefined : pick(option.partners, random);
    nodes.push(chosen.added);
    if (option === undefined || partner === undefined) continue;
    const from = option.forward ? chosen.added : partner;
    const to = option.forward ? partner : chosen.added;
    edges.push({ direction: 'from-to', properties: [], evidenceRefs: [], qualityFlags: [], ref: { sourceId: profile.sourceId, stableId: `fixture-r-add-${round}-${index}` }, from: from.ref, to: to.ref, type: option.relationship.type, semantics: 'stored' });
  }
  return { nodes, edges };
}
