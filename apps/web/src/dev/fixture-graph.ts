import type { ElementRef, GraphEdge, GraphNode, SourceProfile } from '@neburyx/contracts';
import { edgeKey } from '../state/keys.js';
import { createRandom, pickIndex, type Random } from './random.js';

export const GENERATOR_MARKER = 'neburyx-dev-fixture-generator';
export const FIXTURE_ELEMENTS = 300;
export const FIXTURE_PINS = 10;

const NODE_SHARE = 0.4;
const DERIVED_SHARE = 0.12;
const ATTEMPTS = 40;

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

function nodeAt(profile: SourceProfile, type: string, label: string, index: number): GraphNode {
  const stableId = `fixture-${String(index).padStart(4, '0')}`;
  return {
    ref: { sourceId: profile.sourceId, entityType: type, stableId },
    display: { title: `${label} ${stableId}`, type },
    properties: [],
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
    if (entityType !== undefined) nodes.push(nodeAt(profile, entityType.type, entityType.label, index));
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
