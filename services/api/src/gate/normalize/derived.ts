import type { EdgeRef, ElementRef, GraphEdge } from '@neburyx/contracts';
import type { DerivedNormalizer, NormalizeContext } from './model.js';
import { noDrops, warningsOf } from './drops.js';
import type { Normalized } from './index.js';

/**
 * What a template claims about a derived link: the rule it applies to, the two entities, and the edges of the result that support it, in the order of the rule's chain.
 * Anything else a row might say about the version or the kind of the edge is not part of the claim and is never read.
 */
export interface DerivedClaim {
  readonly ruleId: string;
  readonly from: ElementRef;
  readonly to: ElementRef;
  readonly supports: readonly EdgeRef[];
}

const sameRef = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const sameEntity = (left: ElementRef, right: ElementRef): boolean => left.entityType === right.entityType && left.stableId === right.stableId;

function typeOf(edge: GraphEdge): string {
  return 'aggregate' in edge.ref ? edge.ref.aggregate.type : edge.type;
}

/** The chain of the rule: the supports are the rule's relationship types in order, and they join `from` to `to` through the rule's entity types, each in either direction. */
export function followsRule(rule: DerivedNormalizer, claim: DerivedClaim, supports: readonly GraphEdge[]): boolean {
  const hops = (rule.via.length + 1) / 2;
  if (!Number.isInteger(hops) || supports.length !== hops) return false;
  if (claim.from.entityType !== rule.from || claim.to.entityType !== rule.to) return false;
  let current = claim.from;
  for (const [index, edge] of supports.entries()) {
    if (typeOf(edge) !== rule.via[2 * index]) return false;
    let next: ElementRef;
    if (sameEntity(edge.from, current)) next = edge.to;
    else if (sameEntity(edge.to, current)) next = edge.from;
    else return false;
    const expected = index === hops - 1 ? rule.to : rule.via[2 * index + 1];
    if (next.entityType !== expected) return false;
    current = next;
  }
  return sameEntity(current, claim.to);
}

/**
 * Adds the derived edges that hold up. A derived edge is built from the rule of the mapping, with the rule's version from the mapping, and only when the entities and
 * the supporting edges follow the rule; otherwise it is left out and counted as not mapped. It is never a stored edge.
 */
export function withDerivedEdges(context: NormalizeContext, normalized: Normalized, claims: readonly DerivedClaim[]): Normalized {
  const edges = [...normalized.edges];
  const dropped = { ...noDrops(), ...normalized.dropped };
  const seen = new Set(edges.filter((edge) => 'derived' in edge.ref).map((edge) => JSON.stringify(edge.ref)));
  for (const claim of claims) {
    const rule = context.model.derived.find((candidate) => candidate.id === claim.ruleId);
    const supports = claim.supports.map((ref) => normalized.edges.find((edge) => sameRef(edge.ref, ref)));
    if (rule === undefined || supports.some((support) => support === undefined) || !followsRule(rule, claim, supports as GraphEdge[])) {
      dropped['not-mapped'] += 1;
      continue;
    }
    const ref: EdgeRef = { sourceId: context.sourceId, derived: { ruleId: rule.id, from: claim.from, to: claim.to } };
    if (seen.has(JSON.stringify(ref))) continue;
    seen.add(JSON.stringify(ref));
    edges.push({
      ref,
      from: claim.from,
      to: claim.to,
      type: rule.id,
      direction: 'from-to',
      semantics: 'derived',
      derivation: { ruleId: rule.id, ruleVersion: rule.version, supportingEdgeRefs: [...claim.supports] },
      properties: [],
      evidenceRefs: [],
      qualityFlags: [],
    });
  }
  return { ...normalized, edges, dropped, warnings: warningsOf(dropped, normalized.unreferenced.length) };
}

/**
 * The one derived edge of a pair of entities from every chain that supports it. Each chain is checked on its own as `withDerivedEdges` checks one; a chain that does not follow the rule is counted as not mapped and left
 * out, and the edge names the de-duplicated supports of the chains that hold, in the order of the chains. With no chain that holds there is no edge.
 */
export function withDerivedEdge(context: NormalizeContext, normalized: Normalized, claims: readonly DerivedClaim[]): Normalized {
  const dropped = { ...noDrops(), ...normalized.dropped };
  const held: DerivedClaim[] = [];
  for (const claim of claims) {
    const rule = context.model.derived.find((candidate) => candidate.id === claim.ruleId);
    const supports = claim.supports.map((ref) => normalized.edges.find((edge) => sameRef(edge.ref, ref)));
    if (rule === undefined || supports.some((support) => support === undefined) || !followsRule(rule, claim, supports as GraphEdge[])) dropped['not-mapped'] += 1;
    else held.push(claim);
  }
  const first = held[0];
  const rule = first === undefined ? undefined : context.model.derived.find((candidate) => candidate.id === first.ruleId);
  if (first === undefined || rule === undefined || held.some((claim) => !sameEntity(claim.from, first.from) || !sameEntity(claim.to, first.to))) return { ...normalized, dropped, warnings: warningsOf(dropped, normalized.unreferenced.length) };
  const named = new Map<string, EdgeRef>();
  for (const claim of held) for (const ref of claim.supports) named.set(JSON.stringify(ref), ref);
  const ref: EdgeRef = { sourceId: context.sourceId, derived: { ruleId: rule.id, from: first.from, to: first.to } };
  const edge: GraphEdge = {
    ref,
    from: first.from,
    to: first.to,
    type: rule.id,
    direction: 'from-to',
    semantics: 'derived',
    derivation: { ruleId: rule.id, ruleVersion: rule.version, supportingEdgeRefs: [...named.values()] },
    properties: [],
    evidenceRefs: [],
    qualityFlags: [],
  };
  return { ...normalized, edges: [...normalized.edges.filter((existing) => !sameRef(existing.ref, ref)), edge], dropped, warnings: warningsOf(dropped, normalized.unreferenced.length) };
}
