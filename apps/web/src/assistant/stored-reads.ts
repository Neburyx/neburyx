import { MAX_READ_REFS, type EdgeRef, type ElementRef, type GraphEdge, type GraphNode } from '@neburyx/contracts';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { useApiClient } from '../api/client-context.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useAssistantSession } from './assistant-session.js';

type Ref = ElementRef | EdgeRef;
type ChunkStatus = 'loading' | 'failed' | 'done';

/** What the panel holds of the elements the stored answers cite, as the gate returned them under the session's current mask. */
export interface RefReads {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly edges: ReadonlyMap<string, GraphEdge>;
  /** The references that no longer resolve (gone, no longer mapped, or not readable by the person), or that name another source than the investigation's. */
  readonly missing: ReadonlySet<string>;
  readonly loading: boolean;
  /** At least one chunk failed: what the other chunks returned stays drawn, and `retry` reads only the failed ones. */
  readonly failed: boolean;
  readonly retry: () => void;
}

export const refKeyOf = (ref: Ref): string => ('entityType' in ref ? elementKey(ref) : edgeKey(ref));

interface Chunk {
  readonly id: string;
  readonly request: { readonly entities: ElementRef[]; readonly edges: Extract<EdgeRef, { stableId: string }>[]; readonly aggregates: Extract<EdgeRef, { aggregate: unknown }>[]; readonly derived: Extract<EdgeRef, { derived: unknown }>[] };
}

/** The references split by kind and into reads of at most the route's maximum of each kind, for the one source of the investigation; the order of the references is kept inside a kind. */
function chunksOf(refs: readonly Ref[]): Chunk[] {
  const entities: ElementRef[] = [];
  const edges: Chunk['request']['edges'] = [];
  const aggregates: Chunk['request']['aggregates'] = [];
  const derived: Chunk['request']['derived'] = [];
  for (const ref of refs) {
    if ('entityType' in ref) entities.push(ref);
    else if ('aggregate' in ref) aggregates.push(ref);
    else if ('derived' in ref) derived.push(ref);
    else edges.push(ref);
  }
  const pieces = <T,>(list: readonly T[]): T[][] => Array.from({ length: Math.ceil(list.length / MAX_READ_REFS) }, (_, index) => list.slice(index * MAX_READ_REFS, (index + 1) * MAX_READ_REFS));
  const empty = { entities: [], edges: [], aggregates: [], derived: [] };
  return [
    ...pieces(entities).map((list) => ({ ...empty, entities: list })),
    ...pieces(edges).map((list) => ({ ...empty, edges: list })),
    ...pieces(aggregates).map((list) => ({ ...empty, aggregates: list })),
    ...pieces(derived).map((list) => ({ ...empty, derived: list })),
  ].map((request) => ({ id: [...request.entities, ...request.edges, ...request.aggregates, ...request.derived].map(refKeyOf).join('\u0000'), request }));
}

interface Held {
  readonly epoch: number;
  readonly nodes: Map<string, GraphNode>;
  readonly edges: Map<string, GraphEdge>;
  readonly missing: Set<string>;
  readonly chunks: Map<string, ChunkStatus>;
}

const freshAt = (epoch: number): Held => ({ epoch, nodes: new Map(), edges: new Map(), missing: new Set(), chunks: new Map() });

/**
 * Reads the elements the shown answers cite by reference through the application's route, for the investigation's source and under the session's current mask, a chunk at a time. Everything read belongs to one epoch of the session: a clearing (a
 * change of masking, access, investigation or source) ends the reads that are out and purges what was held before the next read, and a response of an earlier epoch is dropped. A failed chunk is drawn as unavailable and is read again alone by `retry`.
 * Nothing is read while `enabled` is false.
 */
export function useRefReads(refs: readonly Ref[], enabled = true): RefReads {
  const client = useApiClient();
  const { store, open } = useAssistantSession();
  const state = useClientState();
  const epoch = useStoreSelector(store, (held) => held.epoch);
  const mask = useStoreSelector(store, (held) => held.mask);
  const sourceId = useStoreSelector(state.investigation, (investigation) => investigation.sourceId);
  const [tick, bump] = useReducer((count: number) => count + 1, 0);
  const held = useRef<Held>(freshAt(epoch));
  // the holder of the earlier epoch is dropped before anything is drawn from it
  if (held.current.epoch !== epoch) held.current = freshAt(epoch);
  const keyList = refs.map(refKeyOf).join('\u0001');
  const [readable, foreign] = useMemo(() => {
    const own = refs.filter((ref) => ref.sourceId === sourceId);
    return [chunksOf(own), refs.filter((ref) => ref.sourceId !== sourceId).map(refKeyOf)] as const;
  }, [keyList, sourceId]);

  useEffect(() => {
    if (!enabled || sourceId === null) return;
    const mine = held.current;
    for (const chunk of readable) {
      if (mine.chunks.has(chunk.id)) continue;
      mine.chunks.set(chunk.id, 'loading');
      const controller = new AbortController();
      open.add(controller);
      void client.readRefs({ sourceId, ...(mask ? { mask: true } : {}), ...chunk.request }, controller.signal).then((result) => {
        open.delete(controller);
        // a response of another epoch, or of a read that was ended, is dropped; a read that was ended is asked again when the references are shown again
        if (held.current !== mine) return;
        if (controller.signal.aborted) {
          mine.chunks.delete(chunk.id);
          bump();
          return;
        }
        if (!result.ok) mine.chunks.set(chunk.id, 'failed');
        else {
          for (const node of result.value.nodes) mine.nodes.set(elementKey(node.ref), node);
          for (const edge of result.value.edges) mine.edges.set(edgeKey(edge.ref), edge);
          for (const ref of result.value.missing.entities) mine.missing.add(elementKey(ref));
          for (const ref of result.value.missing.edges) mine.missing.add(edgeKey(ref));
          mine.chunks.set(chunk.id, 'done');
        }
        bump();
      });
    }
  }, [client, enabled, epoch, mask, open, readable, sourceId, tick]);

  // closing the panel ends what is out
  useEffect(
    () => () => {
      for (const controller of open) controller.abort();
      open.clear();
    },
    [open],
  );

  const current = held.current;
  const statuses = readable.map((chunk) => current.chunks.get(chunk.id));
  return {
    nodes: current.nodes,
    edges: current.edges,
    missing: new Set([...current.missing, ...foreign]),
    loading: enabled && statuses.some((status) => status === undefined || status === 'loading'),
    failed: statuses.some((status) => status === 'failed'),
    retry: () => {
      for (const chunk of readable) if (current.chunks.get(chunk.id) === 'failed') current.chunks.delete(chunk.id);
      bump();
    },
  };
}
