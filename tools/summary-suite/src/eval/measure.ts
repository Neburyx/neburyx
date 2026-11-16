import type { GraphEdge, GraphNode, SummaryReading } from '@neburyx/contracts';
import type { LabelledCase } from '../cases.js';
import { readingOf } from '../cases.js';

/** The product's own estimate: the bytes of the text over this many make its tokens (`BYTES_PER_TOKEN_ESTIMATE` of the summarizer). */
const ESTIMATED_BYTES_PER_TOKEN = 3;

export interface Measurement {
  readonly id: string;
  readonly kind: 'view' | 'sample';
  readonly elements: number;
  /** Whether the call was made and the provider stated its input tokens. */
  readonly measured: boolean;
  /** Why the view was not measured: refused by the size guard, a failed call, usage not stated, or a scripted provider. */
  readonly missing?: string;
  /** UTF-8 bytes of the instructions plus the values: what the guard estimates. */
  readonly bytes?: number;
  readonly estimatedTokens?: number;
  /** Input tokens counted by the provider, with the cache read and write counts when it states them. */
  readonly inputTokens?: number;
  readonly bytesPerToken?: number;
  readonly tokensPerElement?: number;
}

export interface Proposal {
  readonly proposed: boolean;
  /** The smallest bytes-per-token of the measurements that succeeded, rounded down to one decimal: it replaces the estimate of 3. */
  readonly bytesPerToken?: number;
  /** The most input tokens measured for a view at the element cap, times 1.2, rounded up to the next 1,000. */
  readonly maxInputTokens?: number;
  /** What is missing when nothing is proposed. */
  readonly missing: readonly string[];
}

export const elementsOf = (view: SummaryReading): number => view.nodes.length + view.edges.length;

/** The estimate of the product for a text of this many UTF-8 bytes. */
export const estimatedTokensOf = (bytes: number): number => Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN);

export const utf8Bytes = (...parts: readonly string[]): number => parts.reduce((total, part) => total + Buffer.byteLength(part, 'utf8'), 0);

/**
 * A view of exactly `elements` elements (entities and relationships) built from a labelled view: its entities and relationships repeated, each copy under new ids, with the same types, titles' shapes and properties;
 * what is left over at the end is filled with entities of the next copy. The same input always gives the same view.
 */
export function scaledReading(base: LabelledCase, elements: number): SummaryReading {
  const view = readingOf(base);
  const per = elementsOf(view);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let copy = 0;
  while (nodes.length + edges.length + per <= elements) {
    const suffix = `-c${copy}`;
    const renamed = new Map<string, GraphNode['ref']>();
    for (const node of view.nodes) {
      const ref = { ...node.ref, stableId: `${node.ref.stableId}${suffix}` };
      renamed.set(node.ref.stableId, ref);
      nodes.push({ ...node, ref, display: { ...node.display, title: node.display.title === node.ref.stableId ? ref.stableId : node.display.title } });
    }
    for (const edge of view.edges) {
      const from = renamed.get(edge.from.stableId) ?? edge.from;
      const to = renamed.get(edge.to.stableId) ?? edge.to;
      const ref = 'stableId' in edge.ref ? { ...edge.ref, stableId: `${edge.ref.stableId}${suffix}` } : edge.ref;
      edges.push({ ...edge, ref, from, to });
    }
    copy += 1;
  }
  let extra = 0;
  while (nodes.length + edges.length < elements) {
    const source = view.nodes[extra % view.nodes.length];
    if (source === undefined) break;
    const ref = { ...source.ref, stableId: `${source.ref.stableId}-x${extra}` };
    nodes.push({ ...source, ref, display: { ...source.display, title: source.display.title === source.ref.stableId ? ref.stableId : source.display.title } });
    extra += 1;
  }
  return { ...view, nodes, edges };
}

/** The ratio and the guard a set of measurements supports, or what is missing. A measurement that is not whole, a run with no successful AML view and a run with no successful sample at the element cap propose nothing. */
export function proposalOf(measurements: readonly Measurement[], aml: ReadonlySet<string>, elementCap: number): Proposal {
  const missing: string[] = [];
  const succeeded = measurements.filter((each) => each.measured && each.bytes !== undefined && each.inputTokens !== undefined && each.inputTokens > 0);
  for (const each of measurements) if (!each.measured) missing.push(`${each.id}: ${each.missing ?? 'not measured'}`);
  if (!succeeded.some((each) => each.kind === 'view' && aml.has(each.id))) missing.push('no AML view was measured');
  const atCap = succeeded.filter((each) => each.kind === 'sample' && each.elements === elementCap);
  if (atCap.length === 0) missing.push(`no sample of ${elementCap} elements was measured`);
  if (missing.length > 0) return { proposed: false, missing };
  const ratios = succeeded.map((each) => (each.bytes ?? 0) / (each.inputTokens ?? 1));
  const bytesPerToken = Math.floor(Math.min(...ratios) * 10) / 10;
  const largest = Math.max(...atCap.map((each) => each.inputTokens ?? 0));
  return { proposed: true, bytesPerToken, maxInputTokens: Math.ceil((largest * 1.2) / 1000) * 1000, missing: [] };
}
