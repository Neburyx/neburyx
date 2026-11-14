import { plainNode, plainRelationship } from './normalize-fixtures.js';

export const PATHS_ENTITIES = [
  { type: 'maker', label: 'Maker', stable_id: 'makerId', pii: [{ property: 'ownerName', class: 'name' }] },
  { type: 'tool', label: 'Tool', stable_id: 'toolId' },
  { type: 'shop', label: 'Shop', stable_id: 'shopId' },
];

/** Makers by their stable ID, each with one element ID for the whole test, so that the relationships of a path point at the nodes of the same path. */
export function makerNodes() {
  const known = new Map<string, ReturnType<typeof plainNode>>();
  const maker = (id: string) => {
    const existing = known.get(id);
    if (existing !== undefined) return existing;
    const created = plainNode(['Maker'], { makerId: id, ownerName: `Owner of ${id}` });
    known.set(id, created);
    return created;
  };
  /** `stored: 'reverse'` stores each relationship from the later entity to the earlier one, as a path walked against the stored direction crosses them. */
  const path = (ids: readonly string[], type = 'LINKS', extra: Record<string, unknown> = {}, stored: 'forward' | 'reverse' = 'forward') => ({
    $type: 'path' as const,
    start: maker(ids[0] ?? ''),
    segments: ids.slice(1).map((id, position) => ({ relationship: stored === 'forward' ? plainRelationship(type, maker(ids[position] ?? ''), maker(id), { linkId: `${ids[position]}>${id}`, ...extra }) : plainRelationship(type, maker(id), maker(ids[position] ?? ''), { linkId: `${id}>${ids[position]}`, ...extra }), end: maker(id) })),
  });
  return { maker, path, /** The rows of a read: one for each path, each with the two ends, or one with no path. */
    rows: (from: string, to: string, paths: readonly (readonly string[])[], extra: Record<string, unknown> = {}) => (paths.length === 0 ? [{ a: maker(from), b: maker(to), p: null }] : paths.map((ids) => ({ a: maker(from), b: maker(to), p: path(ids, 'LINKS', extra) }))) };
}
