import type { ElementRef, SummaryFailureKind, GraphEdge, GraphNode, SummaryRequest, SummaryResponse } from '@neburyx/contracts';
import type { ApiFailure, ApiResult } from '../api/client.js';

import { viewRefsOf } from '../exports/export-attempt.js';
import { reasonOf } from '../patterns/failure-words.js';
import { edgeKey, elementKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';

export type DraftResponse = Extract<SummaryResponse, { status: 'ok' | 'partial' }>;
type UnsupportedResponse = Extract<SummaryResponse, { status: 'unsupported' }>;
type TooLargeResponse = Extract<SummaryResponse, { status: 'tooLarge' }>;

/** The references of what the canvas shows, as the request of a summary takes them: never their content. */
export function summaryRequestOf(graph: LoadedGraph, investigationId: string, sourceId: string, mask: boolean): SummaryRequest {
  return { investigationId, sourceId, ...(mask ? { mask: true as const } : {}), ...viewRefsOf(graph) };
}

export interface CitationEntry {
  readonly key: string;
  readonly number: number;
  readonly kind: 'entity' | 'relationship';
  readonly graphKey: string;
  /** What the person saw of the element when the draft arrived; undefined when the graph did not hold it then. */
  readonly label: string | undefined;
}

const titleOf = (node: GraphNode): string => (node.display.title === '' ? node.ref.stableId : node.display.title);

function relationshipLabel(edge: GraphEdge, nodes: ReadonlyMap<string, GraphNode>): string {
  const end = (ref: ElementRef): string => nodes.get(elementKey(ref))?.display.title || ref.stableId;
  return `${end(edge.from)} → ${end(edge.to)} · ${edge.type}`;
}

/** The numbers 1, 2, 3 of the cited elements in the order of their first citation, then those of the response that no sentence cites; one number for one key. The labels are fixed here, from the graph the person holds, so a later change of the graph never rewrites a draft. */
export function citationEntries(response: { readonly sentences: readonly { readonly cites: readonly string[] }[]; readonly citations: readonly (DraftResponse['citations'][number] & { readonly title?: string })[] }, graph: LoadedGraph): readonly CitationEntry[] {
  const nodes = new Map(graph.nodes.map((node) => [elementKey(node.ref), node]));
  const edges = new Map(graph.edges.map((edge) => [edgeKey(edge.ref), edge]));
  const known = new Map(response.citations.map((citation) => [citation.key, citation]));
  const order: string[] = [];
  for (const sentence of response.sentences) for (const key of sentence.cites) if (known.has(key) && !order.includes(key)) order.push(key);
  for (const citation of response.citations) if (!order.includes(citation.key)) order.push(citation.key);
  return order.flatMap((key, index) => {
    const citation = known.get(key);
    if (citation === undefined) return [];
    const { ref } = citation;
    if ('entityType' in ref) {
      const node = nodes.get(elementKey(ref));
      return [{ key, number: index + 1, kind: citation.kind, graphKey: elementKey(ref), label: node === undefined ? citation.title : titleOf(node) }];
    }
    const edge = edges.get(edgeKey(ref));
    return [{ key, number: index + 1, kind: citation.kind, graphKey: edgeKey(ref), label: edge === undefined ? citation.title : relationshipLabel(edge, nodes) }];
  });
}

export type PressOutcome = { readonly kind: 'select' } | { readonly kind: 'note'; readonly text: string };

/** What a press on a citation does: select the element when it is drawn, else say why it cannot be. Nothing is read. */
export function pressOf(entry: CitationEntry, drawn: ReadonlySet<string>, held: ReadonlySet<string>, copy: { readonly outsideView: string; readonly gone: string }): PressOutcome {
  if (drawn.has(entry.graphKey)) return { kind: 'select' };
  return { kind: 'note', text: held.has(entry.graphKey) ? copy.outsideView : copy.gone };
}

export type SummaryOutcome =
  | { readonly kind: 'unsupported'; readonly response: UnsupportedResponse }
  | { readonly kind: 'too-large'; readonly response: TooLargeResponse }
  | { readonly kind: 'time-limit' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly failureKind: SummaryFailureKind }
  | { readonly kind: 'request-failed'; readonly failure: ApiFailure }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'source-changed' }
  | { readonly kind: 'cleared'; readonly reason: 'investigation' | 'masking' };

/** What an answer of the server is to the panel: a draft to show, or the outcome to say. */
export function settledOf(result: ApiResult<SummaryResponse>): { readonly draft: DraftResponse } | { readonly outcome: SummaryOutcome } {
  if (!result.ok) return { outcome: outcomeOfFailure(result.failure) };
  const response = result.value;
  switch (response.status) {
    case 'ok':
    case 'partial':
      return { draft: response };
    case 'unsupported':
      return { outcome: { kind: 'unsupported', response } };
    case 'tooLarge':
      return { outcome: { kind: 'too-large', response } };
    case 'timeLimit':
      return { outcome: { kind: 'time-limit' } };
    case 'failed':
      return { outcome: { kind: 'failed', failureKind: response.kind } };
    default:
      return response satisfies never;
  }
}

function outcomeOfFailure(failure: ApiFailure): SummaryOutcome {
  const reason = reasonOf(failure);
  if (failure.code === 'ASK_UNSUPPORTED' || (failure.code === 'ACCESS_DENIED' && reason === 'ai-off')) return { kind: 'unavailable' };
  if ((failure.code === 'CONFLICT' && reason === 'source-changed') || failure.code === 'ABORTED') return { kind: 'source-changed' };
  return { kind: 'request-failed', failure };
}

/** Whether the person changed the text of any sentence of the draft. */
export const editedOf = (draft: { readonly response: DraftResponse; readonly edits: ReadonlyMap<number, string> }): boolean => [...draft.edits].some(([index, edited]) => edited !== draft.response.sentences[index]?.text);

/** How many sentences of the draft the server says Copy to notes will keep. */
export const storableCountOf = (response: DraftResponse): number => response.sentences.filter((sentence) => sentence.storable).length;
