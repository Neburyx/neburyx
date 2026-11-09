import type { GateContext, Item } from '../gate/types.js';
import { plainNode, plainRelationship } from './normalize-fixtures.js';

export const DERIVED_ENTITIES = [
  { type: 'maker', label: 'Maker', stable_id: 'makerId' },
  { type: 'tool', label: 'Tool', stable_id: 'toolId' },
];
export const DERIVED_STORED = [{ type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId' }];
export const DERIVED_AGGREGATE = [{ type: 'USES_TOOL', from: 'maker', to: 'tool' }];
export const DERIVED_RULE = { id: 'shared-tool', from: 'maker', to: 'maker', via: ['USES_TOOL', 'tool', 'USES_TOOL'], rule_version: 2, stop_list_property: 'isCommon' };

export const account = (id: string, extra: Record<string, unknown> = {}) => plainNode(['Maker'], { makerId: id, ...extra });
export const device = (id: string, extra: Record<string, unknown> = {}) => plainNode(['Tool'], { toolId: id, ...extra });
export const uses = (from: { elementId: string }, to: { elementId: string }, id: string) => plainRelationship('USES_TOOL', from, to, { useId: id });

type Account = ReturnType<typeof account>;
type Device = ReturnType<typeof device>;

export const pathOf = (start: Account, hops: readonly { relationship: ReturnType<typeof uses>; end: Account | Device }[]) => ({ p: { $type: 'path' as const, start, segments: hops } });

/** The row of an account that reaches another through a device: the path with the two relationships that support the derived edge. */
export function chain(from: string, to: string, via = 'D-1', extra: Record<string, unknown> = {}) {
  const a = account(from, extra);
  const d = device(via);
  const b = account(to, extra);
  return pathOf(a, [
    { relationship: uses(a, d, `${from}-${via}`), end: d },
    { relationship: uses(b, d, `${to}-${via}`), end: b },
  ]);
}

/** A redact stage that takes the node of one stable ID out of the result before the gate's own, as a policy that hides it would, so that the derived edges that end at it must be dropped. */
export function hidingRedact(stableId: string, redact: (items: readonly Item[], context: GateContext) => readonly Item[]): (items: readonly Item[], context: GateContext) => readonly Item[] {
  const without = (item: Item): Item => {
    const nodes = item['nodes'];
    return Array.isArray(nodes) ? { ...item, nodes: nodes.filter((node: { ref: { stableId: string } }) => node.ref.stableId !== stableId) } : item;
  };
  return (items, context) => redact(items.map(without), context);
}
