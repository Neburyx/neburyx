import type { AskSummary, AskSummaryCitation } from '@neburyx/contracts';
import { edgeKey, elementKey } from '../state/keys.js';
import type { Addable } from './result-model.js';

export const SUMMARY_COPY = {
  notAdded: 'Use Add to graph first',
  neverAdded: 'Not added by this answer',
  outsideView: 'Outside the current view',
  removed: 'No longer on the graph',
  select: 'Select on graph',
  selected: 'Selected on graph',
} as const;

/** The key of a citation's element in the graph: an entity or a relationship. */
export function citationKey(citation: AskSummaryCitation): string {
  return 'entityType' in citation.element ? elementKey(citation.element) : edgeKey(citation.element);
}

/** The number a marker shows: the order of the first citation, which the key `n3` already is. */
export function markerNumber(key: string): string {
  return key.replace(/^n/, '');
}

export interface PressInput {
  readonly key: string;
  /** The keys the investigation holds. */
  readonly held: ReadonlySet<string>;
  /** The keys that are drawn now: not hidden, not filtered out, not outside the focus. */
  readonly drawn: ReadonlySet<string>;
  readonly addable: Addable | undefined;
  /** Whether the result was added to the graph from this card. */
  readonly added: boolean;
}

export type PressOutcome = { readonly kind: 'select'; readonly key: string } | { readonly kind: 'note'; readonly text: string };

/** What a press on a marker does: select the element when it is drawn (that comes before any message), else say why it cannot be. Nothing is read. */
export function pressOutcome({ key, held, drawn, addable, added }: PressInput): PressOutcome {
  if (drawn.has(key)) return { kind: 'select', key };
  if (held.has(key)) return { kind: 'note', text: SUMMARY_COPY.outsideView };
  const listed = addable === undefined ? false : addable.nodes.some((node) => elementKey(node.ref) === key) || addable.edges.some((edge) => edgeKey(edge.ref) === key);
  if (!listed) return { kind: 'note', text: SUMMARY_COPY.neverAdded };
  return { kind: 'note', text: added ? SUMMARY_COPY.removed : SUMMARY_COPY.notAdded };
}
