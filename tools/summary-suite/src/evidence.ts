import type { Count, GraphNode, SummaryReading } from '@neburyx/contracts';
import { defined } from './checks.js';
import { edge } from './view.js';

export const NUMBER_ON_THE_SECOND = '7311';

/** The counted relationships a rule needs to be shown on a view: an estimated, a lower-bound and an unknown count, between the first two entities. */
export const COUNT_TYPES = { estimated: 'EXTRA_ESTIMATED', lowerBound: 'EXTRA_LOWER_BOUND', unknown: 'EXTRA_UNKNOWN' } as const;

const count = (found: Count): Count => found;

/**
 * A view with the evidence the rules of the checks need added to it: a number that only the second entity holds, and three counted relationships between the first two entities. The rest
 * of the view is as the labelled set gives it.
 */
export function withEvidence(view: SummaryReading): SummaryReading {
  const first = defined(view.nodes[0], 'the first entity');
  const second = defined(view.nodes[1], 'the second entity');
  const marked: GraphNode = { ...second, properties: [...second.properties, { key: 'ledger', value: NUMBER_ON_THE_SECOND, dataClass: 'text', masked: false }] };
  const counted = (type: string, members: Count) =>
    edge(type, type, first.ref, second.ref, { ref: { sourceId: 'demo', aggregate: { type, from: first.ref, to: second.ref } }, memberCount: members });
  return {
    ...view,
    nodes: [first, marked, ...view.nodes.slice(2)],
    edges: [
      ...view.edges,
      counted(COUNT_TYPES.estimated, count({ value: 40, quality: 'estimated', scope: 'coverage' })),
      counted(COUNT_TYPES.lowerBound, count({ value: 500, quality: 'lowerBound', scope: 'coverage' })),
      counted(COUNT_TYPES.unknown, count({ quality: 'unknown', scope: 'coverage' })),
    ],
  };
}
