import type { GraphEdge, GraphNode, SummaryReading } from '@neburyx/contracts';
import type { LabelledCase } from '../cases.js';
import { readingOf } from '../cases.js';

/** The product's own estimate, `BYTES_PER_TOKEN_ESTIMATE` of the summarizer; a test keeps the two equal. */
const ESTIMATED_BYTES_PER_TOKEN = 1.8;

export interface Measurement {
  readonly id: string;
  readonly kind: 'view' | 'sample';
  /** For a sample: the properties its elements carry. */
  readonly properties?: 'none' | 'realistic' | 'heavy';
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
  /** The smallest bytes-per-token of the measurements that succeeded, rounded down to one decimal: it replaces the product's estimate. */
  readonly bytesPerToken?: number;
  /** The guard: the estimate (bytes over the proposed ratio, as the product counts) of the larger of the plain and the realistic sample at the element cap, times 1.2, rounded up to the next 1,000. */
  readonly maxInputTokens?: number;
  /** What the guard would be if the elements were heavy (the heavy sample at the element cap, by the same rule): the documented upper bound, not a default. */
  readonly upperBoundMaxInputTokens?: number;
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

/** The ratio and the guard a set of measurements supports, or what is missing: the guard is the larger of the plain and the realistic samples at the element cap (the heavy ones give the upper bound, apart). A measurement that is not whole, a run with no successful AML view and a run with no successful sample at the element cap propose nothing. */
export function proposalOf(measurements: readonly Measurement[], aml: ReadonlySet<string>, elementCap: number): Proposal {
  const missing: string[] = [];
  const succeeded = measurements.filter((each) => each.measured && each.bytes !== undefined && each.inputTokens !== undefined && each.inputTokens > 0);
  for (const each of measurements) if (!each.measured) missing.push(`${each.id}: ${each.missing ?? 'not measured'}`);
  if (!succeeded.some((each) => each.kind === 'view' && aml.has(each.id))) missing.push('no AML view was measured');
  const atCap = succeeded.filter((each) => each.kind === 'sample' && each.elements === elementCap && each.properties !== 'heavy');
  if (atCap.length === 0) missing.push(`no sample of ${elementCap} elements was measured`);
  if (missing.length > 0) return { proposed: false, missing };
  const ratios = succeeded.map((each) => (each.bytes ?? 0) / (each.inputTokens ?? 1));
  const bytesPerToken = Math.floor(Math.min(...ratios) * 10) / 10;
  const guardOf = (samples: readonly Measurement[]): number => Math.ceil(((Math.max(...samples.map((each) => each.bytes ?? 0)) / bytesPerToken) * 1.2) / 1000) * 1000;
  const heavy = succeeded.filter((each) => each.kind === 'sample' && each.elements === elementCap && each.properties === 'heavy');
  return { proposed: true, bytesPerToken, maxInputTokens: guardOf(atCap), ...(heavy.length === 0 ? {} : { upperBoundMaxInputTokens: guardOf(heavy) }), missing: [] };
}

type Property = SummaryReading['nodes'][number]['properties'][number];

const text = (key: string, value: string): Property => ({ key, value, dataClass: 'text', masked: false });

const withProperties = (view: SummaryReading, onNode: (id: string) => Property[], onEdge: (from: string, to: string) => Property[]): SummaryReading => ({
  ...view,
  nodes: view.nodes.map((node) => ({ ...node, properties: [...node.properties, ...onNode(node.ref.stableId)] })),
  edges: view.edges.map((edge) => ({ ...edge, properties: [...edge.properties, ...onEdge(edge.from.stableId, edge.to.stableId)] })),
});

/**
 * The same view with many long properties, an upper bound only: eight on each entity and three on each relationship, text values of a sentence's length, written from the element's own id so that the
 * same input gives the same view.
 */
export const heavyReading = (view: SummaryReading): SummaryReading =>
  withProperties(
    view,
    (id) => Array.from({ length: 8 }, (_, index) => text(`attribute_${index + 1}`, `value ${index + 1} of ${id}, written as a short descriptive text of the kind a source holds`)),
    (from, to) => Array.from({ length: 3 }, (_, index) => text(`detail_${index + 1}`, `value ${index + 1} of ${from} to ${to}, written as a short descriptive text of the kind a source holds`)),
  );

/** The same view with the properties of the demo packs' elements: four short ones on each entity (a status, a date, an amount, a region) and one on each relationship. The same input gives the same view. */
export const realisticReading = (view: SummaryReading): SummaryReading =>
  withProperties(
    view,
    (id) => {
      const number = [...id].reduce((total, character) => total + character.charCodeAt(0), 0);
      return [text('status', number % 2 === 0 ? 'open' : 'closed'), text('opened', `2026-0${(number % 9) + 1}-1${number % 9}`), text('amount', `${(number % 90) * 100 + 250}.00`), text('region', ['north', 'south', 'east', 'west'][number % 4] ?? 'north')];
    },
    () => [text('channel', 'web')],
  );
