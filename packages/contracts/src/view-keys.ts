import { z } from 'zod';
import { aggregateEdgeRefSchema, derivedEdgeRefSchema } from './edge-detail.js';
import type { ElementRefs } from './extension.js';
import { elementRefSchema, storedEdgeRefSchema, type ElementRef } from './graph.js';

export type ReadViewKeys = { readonly ok: true; readonly refs: ElementRefs } | { readonly ok: false };

const part = z.string().min(1);
const nodeKeySchema = z.tuple([z.literal('node'), part, part, part]);
const storedKeySchema = z.tuple([z.literal('edge'), part, z.literal('stored'), part, part, part, part]);
const aggregateKeySchema = z.tuple([z.literal('edge'), part, z.literal('aggregate'), part, part, part]);
const derivedKeySchema = z.tuple([z.literal('edge'), part, z.literal('derived'), part, part, part]);

function parse(key: string): unknown {
  try {
    return JSON.parse(key);
  } catch {
    return undefined;
  }
}

/** An entity key, whole: the nested ends of an aggregate or a derived key are entity keys written as strings. */
function entityOf(key: string): ElementRef | undefined {
  const node = nodeKeySchema.safeParse(parse(key));
  if (!node.success) return undefined;
  const ref = elementRefSchema.safeParse({ sourceId: node.data[1], entityType: node.data[2], stableId: node.data[3] });
  return ref.success ? ref.data : undefined;
}

type Reading = { readonly kind: 'entities' | 'edges' | 'aggregates' | 'derived'; readonly ref: unknown; readonly sources: readonly string[] };

function readOne(key: string): Reading | undefined {
  const json = parse(key);
  const node = entityOf(key);
  if (node !== undefined) return { kind: 'entities', ref: node, sources: [node.sourceId] };
  const stored = storedKeySchema.safeParse(json);
  if (stored.success) {
    const ref = storedEdgeRefSchema.safeParse({ sourceId: stored.data[1], type: stored.data[3], from: stored.data[4], to: stored.data[5], stableId: stored.data[6] });
    return ref.success ? { kind: 'edges', ref: ref.data, sources: [ref.data.sourceId] } : undefined;
  }
  const aggregate = aggregateKeySchema.safeParse(json);
  if (aggregate.success) {
    const from = entityOf(aggregate.data[4]);
    const to = entityOf(aggregate.data[5]);
    if (from === undefined || to === undefined) return undefined;
    const ref = aggregateEdgeRefSchema.safeParse({ sourceId: aggregate.data[1], aggregate: { type: aggregate.data[3], from, to } });
    return ref.success ? { kind: 'aggregates', ref: ref.data, sources: [ref.data.sourceId, from.sourceId, to.sourceId] } : undefined;
  }
  const derived = derivedKeySchema.safeParse(json);
  if (derived.success) {
    const from = entityOf(derived.data[4]);
    const to = entityOf(derived.data[5]);
    if (from === undefined || to === undefined) return undefined;
    const ref = derivedEdgeRefSchema.safeParse({ sourceId: derived.data[1], derived: { ruleId: derived.data[3], from, to } });
    return ref.success ? { kind: 'derived', ref: ref.data, sources: [ref.data.sourceId, from.sourceId, to.sourceId] } : undefined;
  }
  return undefined;
}

/**
 * Reads the keys of the elements in view back into references, all or none: a key that is not one of the four forms the client writes, whose source (or the source of an end nested in it) is not the given one, or that repeats a reference refuses every key.
 * A key is data of the client and nothing here reads the source.
 */
export function readViewKeys(keys: readonly string[], sourceId: string): ReadViewKeys {
  const lists: { entities: unknown[]; edges: unknown[]; aggregates: unknown[]; derived: unknown[] } = { entities: [], edges: [], aggregates: [], derived: [] };
  const seen = new Set<string>();
  for (const key of keys) {
    const read = readOne(key);
    if (read === undefined || read.sources.some((source) => source !== sourceId)) return { ok: false };
    const identity = `${read.kind}:${JSON.stringify(read.ref)}`;
    if (seen.has(identity)) return { ok: false };
    seen.add(identity);
    lists[read.kind].push(read.ref);
  }
  const refs = z.strictObject({ entities: z.array(elementRefSchema), edges: z.array(storedEdgeRefSchema), aggregates: z.array(aggregateEdgeRefSchema), derived: z.array(derivedEdgeRefSchema) }).safeParse(lists);
  return refs.success ? { ok: true, refs: refs.data } : { ok: false };
}
