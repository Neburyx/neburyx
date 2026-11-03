import type { GraphNode, GraphProperty, PiiClass } from '@neburyx/contracts';
import type { Normalized } from '../normalize/index.js';
import type { EntityNormalizer } from '../normalize/model.js';
import { PLACEHOLDER, placeholderText } from '../normalize/node.js';
import type { GateContext, Item } from '../types.js';
import { canonicalJson } from '../cursor/binding.js';
import { withNotVisible } from '../normalize/drops.js';
import { FULL_MASK, maskValue } from './mask.js';

export { FULL_MASK, maskValue } from './mask.js';

/** A normalized result, as a data template returns it: nodes and edges. */
function isNormalized(item: Item): item is Item & Normalized {
  return Array.isArray(item['nodes']) && Array.isArray(item['edges']);
}

/**
 * The title of a node when it is built from a `pii` field: the title template filled with the mask of each such field and the plain value of the others. A title that is
 * not built from a `pii` field, or that fell back to the type and the stable ID because a value was missing, holds no `pii` value and stays as it is.
 */
function maskedTitle(node: GraphNode, entity: EntityNormalizer): string {
  if (!entity.titleProperties.some((key) => entity.pii.includes(key)) || node.qualityFlags.includes('title-incomplete')) return node.display.title;
  return entity.title.replace(PLACEHOLDER, (_whole, key: string) => {
    const property = node.properties.find((candidate) => candidate.key === key);
    if (property?.value === undefined) return '';
    return entity.pii.includes(key) ? maskOf(property, classOf(entity, key)) : (placeholderText(property.value) ?? '');
  });
}

/** The class the mapping gives a field, read only from the entity's own classes (a field named `constructor` has none). */
const classOf = (entity: EntityNormalizer, key: string): PiiClass | undefined => (Object.hasOwn(entity.piiClasses, key) ? entity.piiClasses[key] : undefined);

/** The mask of a property's value: in the shape of its class when the value is text, and the full mask for any other kind of value (a number, a date, a list). */
const maskOf = (property: GraphProperty, piiClass: PiiClass | undefined): string => (property.dataClass === 'text' ? maskValue(property.value, piiClass) : FULL_MASK);

function maskNode(node: GraphNode, entity: EntityNormalizer): GraphNode {
  const properties = node.properties.map((property) => {
    if (!entity.pii.includes(property.key) || property.value === undefined) return property;
    const piiClass = classOf(entity, property.key);
    return { ...property, value: maskOf(property, piiClass), dataClass: piiClass ?? property.dataClass, masked: true, maskedBy: 'request' as const };
  });
  return { ...node, display: { ...node.display, title: maskedTitle(node, entity) }, properties };
}

/** A reference as text that does not depend on the order of its fields. */
const keyOf = canonicalJson;

/** A derived edge is shown only when both its ends are nodes of the result and every edge that supports it is an edge of the result. */
function withoutHiddenDerived(result: Normalized): Normalized {
  const shownNodes = new Set(result.nodes.map((node) => keyOf(node.ref)));
  const shownEdges = new Set(result.edges.filter((edge) => edge.semantics !== 'derived').map((edge) => keyOf(edge.ref)));
  const edges = result.edges.filter(
    (edge) => edge.semantics !== 'derived' || (shownNodes.has(keyOf(edge.from)) && shownNodes.has(keyOf(edge.to)) && (edge.derivation?.supportingEdgeRefs ?? []).every((ref) => shownEdges.has(keyOf(ref)))),
  );
  const hidden = result.edges.length - edges.length;
  if (hidden === 0) return result;
  const dropped = { ...result.dropped, 'not-visible': (result.dropped['not-visible'] ?? 0) + hidden };
  return { ...result, edges, dropped, warnings: withNotVisible(result.warnings, dropped['not-visible'] ?? 0) };
}

/** Redacts a normalized result: the derived-edge rule always, and the masking when the request asks. */
export function redactResult(visible: Normalized, context: GateContext): Normalized {
  const result = withoutHiddenDerived(visible);
  if (!context.mask) return result;
  const nodes = result.nodes.map((node) => {
    const entity = context.model.entitiesByType.get(node.ref.entityType);
    return entity === undefined ? node : maskNode(node, entity);
  });
  return { ...result, nodes };
}

/**
 * The redact stage: when the request asks for masking, the `pii` fields of the nodes of a normalized result are replaced by their masks before anything leaves the gate.
 * An item that is not a normalized result passes through.
 */
export function redactItems(items: readonly Item[], context: GateContext): readonly Item[] {
  return items.map((item) => (isNormalized(item) ? { ...redactResult(item, context) } : item));
}
