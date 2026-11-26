import { MAX_READ_REFS, type EdgeRef, type ElementRef, type GraphEdge, type GraphNode } from '@neburyx/contracts';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { useApiClient } from '../api/client-context.js';
import { AGGREGATE_REFS_WAIT_MS, boundedRead, READ_WAIT_MS } from '../api/read-wait.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useAssistantSession } from './assistant-session.js';
import { isAccessLost } from './failure-kinds.js';
import { loseAccess } from './thread-reconcile.js';

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
  /** Forgets everything read and reads again: a list that is opened anew shows no label or element from an earlier opening. */
  readonly reset: () => void;
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
  /** The requests this holder has out. */
  readonly controllers: Set<AbortController>;
}

const freshAt = (epoch: number): Held => ({ epoch, nodes: new Map(), edges: new Map(), missing: new Set(), chunks: new Map(), controllers: new Set() });

/** Ends the requests of a holder and empties it, so that nothing it held can be read again from anywhere that still refers to it. */
function retire(held: Held): void {
  for (const controller of held.controllers) controller.abort();
  held.controllers.clear();
  held.nodes.clear();
  held.edges.clear();
  held.missing.clear();
  held.chunks.clear();
}

/** The ends of the relationships that were read and that neither were asked for nor have been read themselves: a relationship cited alone is listed with the titles of its ends as they are now. */
function endsToRead(held: Held, asked: ReadonlySet<string>): ElementRef[] {
  const wanted = new Map<string, ElementRef>();
  for (const edge of held.edges.values())
    for (const end of [edge.from, edge.to]) {
      const key = elementKey(end);
      if (!asked.has(key) && !held.nodes.has(key) && !held.missing.has(key)) wanted.set(key, end);
    }
  return [...wanted.values()];
}

/**
 * Reads the elements the shown answers cite by reference through the application's route, for the investigation's source and under the session's current mask, a chunk at a time, and the ends of the relationships among them. Everything read belongs to one
 * epoch of the session: a clearing (a change of masking, access, investigation or source) ends the reads that are out and empties what was held before the next read, and a response of an earlier epoch is dropped; a refusal that says access was lost
 * clears the session. A failed chunk is drawn as unavailable and is read again alone by `retry`. `reset` forgets everything read and reads again, for a list that is opened anew. Closing the panel ends only the requests this holder made.
 * Nothing is read while `enabled` is false.
 */
export function useRefReads(refs: readonly Ref[], enabled = true): RefReads {
  const client = useApiClient();
  const session = useAssistantSession();
  const { store, stored } = session;
  const state = useClientState();
  const epoch = useStoreSelector(store, (held) => held.epoch);
  const mask = useStoreSelector(store, (held) => held.mask);
  const sourceId = useStoreSelector(state.investigation, (investigation) => investigation.sourceId);
  const [tick, bump] = useReducer((count: number) => count + 1, 0);
  const held = useRef<Held>(freshAt(epoch));
  if (held.current.epoch !== epoch) {
    retire(held.current);
    held.current = freshAt(epoch);
  }
  const keyList = refs.map(refKeyOf).join('\u0001');
  const [own, foreign] = useMemo(() => [refs.filter((ref) => ref.sourceId === sourceId), refs.filter((ref) => ref.sourceId !== sourceId).map(refKeyOf)] as const, [keyList, sourceId]);
  const asked = useMemo(() => new Set(own.map(refKeyOf)), [own]);
  const readable = useMemo(() => chunksOf([...own, ...endsToRead(held.current, asked)]), [own, asked, tick, epoch]);

  useEffect(() => {
    if (!enabled || sourceId === null) return;
    const mine = held.current;
    for (const chunk of readable) {
      if (mine.chunks.has(chunk.id)) continue;
      mine.chunks.set(chunk.id, 'loading');
      const controller = new AbortController();
      mine.controllers.add(controller);
      // a chunk holds one kind of reference: one read of the source (10 s at most), or two for aggregates
      const wait = chunk.request.aggregates.length > 0 ? AGGREGATE_REFS_WAIT_MS : READ_WAIT_MS;
      void boundedRead((signal) => client.readRefs({ sourceId, ...(mask ? { mask: true } : {}), ...chunk.request }, signal), controller.signal, wait).then((result) => {
        mine.controllers.delete(controller);
        // a response of another holder (another epoch, or a list read anew) is dropped
        if (held.current !== mine || controller.signal.aborted) return;
        if (!result.ok) {
          if (isAccessLost(result.failure)) {
            loseAccess(session);
            return;
          }
          mine.chunks.set(chunk.id, 'failed');
        } else {
          for (const node of result.value.nodes) mine.nodes.set(elementKey(node.ref), node);
          for (const edge of result.value.edges) mine.edges.set(edgeKey(edge.ref), edge);
          for (const ref of result.value.missing.entities) mine.missing.add(elementKey(ref));
          for (const ref of result.value.missing.edges) mine.missing.add(edgeKey(ref));
          mine.chunks.set(chunk.id, 'done');
        }
        bump();
      });
    }
  }, [client, enabled, epoch, mask, readable, session, sourceId, stored, tick]);

  // closing the panel ends the requests of this holder and empties it
  useEffect(
    () => () => {
      retire(held.current);
    },
    [],
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
    reset: () => {
      retire(held.current);
      held.current = freshAt(epoch);
      bump();
    },
  };
}
