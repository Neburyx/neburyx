import { MAX_READ_REFS, type Count, type CoverageEntity, type GraphEdge, type GraphNode, type ReadRefsResponse } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError, RequestCancelled } from '../errors.js';
import type { CoverageCall, CoverageService } from '../graph/coverage-service.js';
import type { ReadRefsCall, ReadRefsService } from '../graph/read-refs-service.js';
import { principalFixture } from '../testing/principal-fixture.js';
import { createShownReader, DEFAULT_SHOWN_LIMITS, type ShownReaderLimits } from './shown-reader.js';

const scope = 'not yet retrieved';
const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  ref: { sourceId: 'demo', entityType: 'widget', stableId: id },
  display: { title: id, type: 'Widget' },
  properties: [],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
  ...over,
});
const edgeOf = (id: string, from: string, to: string, over: Partial<GraphEdge> = {}): GraphEdge => ({
  ref: { sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'widget', stableId: id },
  from: { sourceId: 'demo', entityType: 'widget', stableId: from },
  to: { sourceId: 'demo', entityType: 'widget', stableId: to },
  type: 'MADE_FROM',
  direction: 'from-to',
  semantics: 'stored',
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
  ...over,
});
const ref = (id: string) => ({ sourceId: 'demo', entityType: 'widget', stableId: id });
const aggregateRef = (id: string) => ({ sourceId: 'demo', aggregate: { type: 'BARE', from: ref(`F-${id}`), to: ref(`T-${id}`) } });
const derivedRef = (id: string) => ({ sourceId: 'demo', derived: { ruleId: 'rule', from: ref(`F-${id}`), to: ref(`T-${id}`) } });
const storedRef = (id: string) => ({ sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'widget', stableId: id });

function rig(options: { readonly nodes?: (id: string) => GraphNode | undefined; readonly edges?: (id: string) => GraphEdge | undefined; readonly coverage?: (call: CoverageCall) => Count; readonly uncounted?: (call: CoverageCall) => number; readonly hang?: boolean; readonly limits?: Partial<ShownReaderLimits> } = {}) {
  const reads: ReadRefsCall[] = [];
  const asked: CoverageCall[] = [];
  const readRefs: ReadRefsService = {
    read: (call) => {
      reads.push(call);
      if (options.hang === true) return new Promise<ReadRefsResponse>((_resolve, reject) => call.signal?.addEventListener('abort', () => reject(new RequestCancelled())));
      const nodes = call.request.entities.flatMap((entity) => options.nodes?.(entity.stableId) ?? (options.nodes === undefined ? [node(entity.stableId)] : []));
      const edges = call.request.edges.flatMap((entry) => options.edges?.(entry.stableId) ?? []);
      return Promise.resolve({ nodes, edges, missing: { entities: [], edges: [] } });
    },
  };
  const coverage: CoverageService = {
    coverage: (call) => {
      asked.push(call);
      return Promise.resolve({ notRetrieved: options.coverage?.(call) ?? { value: 2, quality: 'exact', scope }, uncounted: options.uncounted?.(call) ?? 0 });
    },
  };
  const reader = createShownReader({ readRefs, coverage, limits: { ...DEFAULT_SHOWN_LIMITS, ...options.limits } });
  const run = (entities: readonly string[], more: { readonly edges?: readonly string[]; readonly aggregates?: readonly string[]; readonly derived?: readonly string[]; readonly signal?: AbortSignal } = {}) =>
    reader.read({ traceId: 't', principal: principalFixture, sourceId: 'demo', entities: entities.map(ref), edges: (more.edges ?? []).map(storedRef), aggregates: (more.aggregates ?? []).map(aggregateRef), derived: (more.derived ?? []).map(derivedRef), ...(more.signal === undefined ? {} : { signal: more.signal }) });
  return { run, reads, asked };
}

const ids = (count: number, start = 0): string[] => Array.from({ length: count }, (_unused, index) => `W-${start + index}`);

describe('reading the shown elements for an export', () => {
  it('reads in calls of at most 100 of each kind, counts no further request, and holds no read across calls', async () => {
    const { run, reads } = rig({ limits: { maxEntities: 1000 } });
    const result = await run(ids(250));
    expect(result.nodes).toHaveLength(250);
    expect(reads.map((call) => call.request.entities.length)).toEqual([MAX_READ_REFS, MAX_READ_REFS, 50]);
    expect(reads.every((call) => call.countRate === false)).toBe(true);
  });

  it('reads a repeated reference once', async () => {
    const { run, reads } = rig();
    await run(['W-1', 'W-1', 'W-2']);
    expect(reads[0]?.request.entities).toHaveLength(2);
  });

  it('refuses more than the limit with the reason and the limit, and reads nothing', async () => {
    const { run, reads } = rig();
    const limits = { reason: 'export-too-large', maxEntities: 300, maxRelationships: 300, maxAggregates: 100 };
    await expect(run(ids(301))).rejects.toMatchObject({ code: 'INVALID_REQUEST', details: { ...limits, exceeded: 'entities' } });
    await expect(run([], { edges: ids(301) })).rejects.toMatchObject({ code: 'INVALID_REQUEST', details: { ...limits, exceeded: 'relationships' } });
    await expect(run([], { aggregates: ids(101) })).rejects.toMatchObject({ code: 'INVALID_REQUEST', details: { ...limits, exceeded: 'aggregates' } });
    expect(reads).toHaveLength(0);
  });

  it('accepts exactly the limit and refuses one more, so the limit can fail', async () => {
    const { run } = rig();
    await expect(run(ids(300))).resolves.toMatchObject({ nodes: expect.any(Array) });
    await expect(run(ids(301))).rejects.toBeInstanceOf(AppError);
  });

  it('accepts 300 entities, 300 stored relationships and 100 aggregated relationships together, and refuses one over each', async () => {
    const { run } = rig();
    await expect(run(ids(300), { edges: ids(300), aggregates: ids(100) })).resolves.toMatchObject({ nodes: expect.any(Array) });
    await expect(run(ids(301), { edges: ids(300), aggregates: ids(100) })).rejects.toMatchObject({ details: { exceeded: 'entities' } });
    await expect(run(ids(300), { edges: ids(301), aggregates: ids(100) })).rejects.toMatchObject({ details: { exceeded: 'relationships' } });
    await expect(run(ids(300), { edges: ids(300), aggregates: ids(101) })).rejects.toMatchObject({ details: { exceeded: 'aggregates' } });
  });

  it('counts derived relationships with the aggregated ones, and the same item named twice once', async () => {
    const { run } = rig();
    await expect(run([], { aggregates: ids(60), derived: ids(40) })).resolves.toMatchObject({ nodes: expect.any(Array) });
    await expect(run([], { aggregates: ids(60), derived: ids(41) })).rejects.toMatchObject({ details: { exceeded: 'aggregates' } });
    await expect(run([], { aggregates: [...ids(100), ...ids(100)] })).resolves.toMatchObject({ nodes: expect.any(Array) });
  });

  it('leaves out a node that may not be exported with every relationship at it, and says only that something was left out', async () => {
    const { run } = rig({ nodes: (id) => node(id, id === 'W-2' ? { authorization: { canInspect: true, canExport: false } } : {}), edges: (id) => (id === 'L-1' ? edgeOf('L-1', 'W-1', 'W-2') : edgeOf(id, 'W-1', 'W-3')) });
    const result = await run(['W-1', 'W-2', 'W-3'], { edges: ['L-1', 'L-2'] });
    expect(result.nodes.map((entry) => entry.ref.stableId)).toEqual(['W-1', 'W-3']);
    expect(result.edges.map((entry) => entry.ref)).toEqual([storedRef('L-2')]);
    expect(result.omitted).toBe(true);
    expect(Object.keys(result)).not.toContain('omittedCount');
    const none = await rig().run(['W-1']);
    expect(none.omitted).toBe(false);
  });

  it('passes each entity with its loaded relationship count and the weakest quality of the aggregates at it, with the mask the reads used', async () => {
    const aggregate = edgeOf('A', 'W-1', 'W-2', { ref: { sourceId: 'demo', aggregate: { type: 'MADE_FROM', from: ref('W-1'), to: ref('W-2') } }, memberCount: { value: 4, quality: 'estimated', scope: 'aggregate:members' } });
    const { run, asked } = rig({ edges: (id) => (id === 'A' ? aggregate : edgeOf(id, 'W-1', 'W-1')) });
    await run(['W-1', 'W-2'], { edges: ['A', 'S'] });
    const [call] = asked;
    expect(call?.mask).toBe(false);
    expect(call?.countRate).toBe(false);
    const byId = new Map((call?.entities ?? []).map((entity: CoverageEntity) => [entity.ref.stableId, entity]));
    expect(byId.get('W-1')).toMatchObject({ loadedRelationships: 4 + 2, loadedQuality: 'estimated' });
    expect(byId.get('W-2')).toMatchObject({ loadedRelationships: 4, loadedQuality: 'estimated' });
  });

  it('splits the coverage call in chunks of at most 500 entities and joins the answers', async () => {
    const { run, asked } = rig({ limits: { maxEntities: 2000, maxRelationships: 2000 }, coverage: (call) => ({ value: call.entities.length, quality: 'exact', scope }) });
    const result = await run(ids(1200));
    expect(asked.map((call) => call.entities.length)).toEqual([500, 500, 200]);
    expect(result.notRetrieved).toMatchObject({ value: 1200, quality: 'estimated' });
  });

  it('adds up what the chunks could not count, and says none for an empty selection', async () => {
    const { run } = rig({ limits: { maxEntities: 2000, maxRelationships: 2000 }, uncounted: (call) => call.entities.length / 100 });
    const result = await run(ids(1200));
    expect(result.uncounted).toBe(5 + 5 + 2);
  });

  it('makes no coverage call for an empty selection and says 0 not yet retrieved, exact', async () => {
    const { run, asked } = rig({ nodes: () => undefined });
    const result = await run(['W-1']);
    expect(asked).toHaveLength(0);
    expect(result.notRetrieved).toEqual({ value: 0, quality: 'exact', scope });
  });

  it('counts the distinct masked fields of what was read', async () => {
    const masked = (key: string) => ({ key, value: '••••••', dataClass: 'phone' as const, masked: true });
    const { run } = rig({ nodes: (id) => node(id, { properties: [masked('phone'), { key: 'name', value: 'x', dataClass: 'text', masked: false }] }) });
    expect((await run(['W-1', 'W-2'])).maskedFields).toBe(1);
  });

  it('answers QUERY_TIMEOUT with the limit when the reads pass the request deadline, and builds nothing', async () => {
    const { run } = rig({ hang: true, limits: { requestTimeoutMs: 20 } });
    await expect(run(['W-1'])).rejects.toMatchObject({ code: 'QUERY_TIMEOUT', details: { timeoutMs: 20 } });
  });

  it('stops the reads when the client aborts, with the cancellation of the client and not a timeout', async () => {
    const { run } = rig({ hang: true });
    const controller = new AbortController();
    const pending = run(['W-1'], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RequestCancelled);
  });
});
