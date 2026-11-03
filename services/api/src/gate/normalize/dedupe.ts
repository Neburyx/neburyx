import type { GraphNode, GraphProperty } from '@neburyx/contracts';

export const nodeKey = (node: GraphNode): string => JSON.stringify([node.ref.entityType, node.ref.stableId]);

const sameValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const addFlag = (flags: readonly string[], flag: string): string[] => (flags.includes(flag) ? [...flags] : [...flags, flag]);

/**
 * The same node seen again: the first keeps its place and its values; a projected property that only the later one has fills a key the first lacks, and a key
 * with two different values keeps the first and flags the node.
 */
export function mergeNode(first: GraphNode, later: GraphNode): GraphNode {
  let flags = [...first.qualityFlags];
  const properties: GraphProperty[] = [...first.properties];
  for (const extra of later.properties) {
    const index = properties.findIndex((property) => property.key === extra.key);
    const known = index < 0 ? undefined : properties[index];
    if (known === undefined) {
      properties.push(extra);
    } else if (known.value === undefined && extra.value !== undefined) {
      properties[index] = extra;
    } else if (known.value !== undefined && extra.value !== undefined && !sameValue(known.value, extra.value)) {
      flags = addFlag(flags, 'conflicting-duplicate');
    }
  }
  if (!properties.some((property) => property.dataClass === 'unknown' && property.value === undefined)) flags = flags.filter((flag) => flag !== 'missing-property');
  return { ...first, properties, qualityFlags: flags };
}
