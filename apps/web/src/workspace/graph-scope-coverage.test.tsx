import { act, cleanup, render, screen, within } from '@testing-library/react';
import { COVERAGE_MAX_ENTITIES, COVERAGE_SCOPE, type Count, type CoverageRequest, type CoverageResponse, type DegreePreview, type GraphEdge } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiFailure, ApiResult } from '../api/client.js';
import { createCoverageStore } from '../api/coverage-store.js';
import { fakeClient } from '../api/fake-client.js';
import { createPreviewStore } from '../api/preview-store.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edgeRef, key, ref, result } from '../state/test-data.js';
import { CoverageProvider } from './coverage-context.js';
import { coverageEntitiesOf } from './coverage-input.js';
import { GraphScope, GraphScopeLines } from './graph-scope.js';
import { PreviewProvider } from './preview-context.js';
import { deriveLoadedGraph } from '../state/loaded-graph.js';

afterEach(() => cleanup());

interface Ask {
  readonly request: CoverageRequest;
  readonly signal: AbortSignal | undefined;
  readonly answer: (result: ApiResult<CoverageResponse>) => void;
}

const counted = (value: number | undefined, quality: Count['quality']): Count => (value === undefined ? { quality: 'unknown', scope: COVERAGE_SCOPE } : { value, quality, scope: COVERAGE_SCOPE });
const ok = (count: Count): ApiResult<CoverageResponse> => ({ ok: true, value: { notRetrieved: count } });
const refused: ApiFailure = { code: 'NETWORK_UNAVAILABLE' };

function load(state: ClientState, ids: readonly string[], links: ReadonlyArray<readonly [string, string, string]> = [], params = 'seed-1'): void {
  state.bindSource('a');
  state.putResult(key('a', params), result('a', ids, links));
  state.setLoaded([key('a', params)], ids.map((id) => ref('a', 'type-a', id)), links.map(([id]) => edgeRef('a', id)));
}

const ids = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `n${index}`);

function harness(options: { readonly nodes?: readonly string[]; readonly links?: ReadonlyArray<readonly [string, string, string]> } = {}) {
  const asks: Ask[] = [];
  const previewAsks: Array<(value: DegreePreview) => void> = [];
  const reported: Array<{ failure: ApiFailure; sourceId: string }> = [];
  const client = fakeClient({
    graphCoverage: (request, signal) => new Promise((resolve) => void asks.push({ request, signal, answer: resolve })),
    previewExpansion: () => new Promise((resolve) => void previewAsks.push((value) => resolve({ ok: true, value }))),
  });
  const state = createClientState();
  load(state, options.nodes ?? ['n1', 'n2'], options.links ?? []);
  const previews = createPreviewStore(client, () => 'person-1');
  const coverage = createCoverageStore(client, () => 'person-1', (failure, sourceId) => (reported.push({ failure, sourceId }), true));
  const tree = (
    <ClientStateProvider state={state}>
      <PreviewProvider store={previews}>
        <CoverageProvider store={coverage}>
          <GraphScope />
        </CoverageProvider>
      </PreviewProvider>
    </ClientStateProvider>
  );
  const view = render(tree);
  return { asks, previewAsks, reported, state, previews, view, tree };
}

const lines = () => within(screen.getByRole('group', { name: 'Graph scope' })).getAllByText(/./).map((line) => line.textContent);
const secondLine = () => lines()[1];
const answer = (ask: Ask | undefined, result: ApiResult<CoverageResponse>) => act(async () => ask?.answer(result));
const previewOf = (): DegreePreview => ({ ref: ref('a', 'type-a', 'n1'), total: { value: 1, quality: 'exact', scope: 'x' }, byType: [], byNeighborType: [], warnings: [], pageSize: 25 });

describe('the second scope line, with the count the server computed', () => {
  it.each([
    [counted(5, 'exact'), '2 shown · 5 not yet retrieved (exact)'],
    [counted(38, 'estimated'), '2 shown · ~38 not yet retrieved (estimated)'],
    [counted(500, 'lowerBound'), '2 shown · ≥ 500 not yet retrieved (lower bound)'],
    [counted(undefined, 'unknown'), '2 shown · more not yet retrieved'],
  ])('reads %j as "%s"', async (count, expected) => {
    const { asks } = harness();
    await answer(asks[0], ok(count));
    expect(secondLine()).toBe(expected);
  });

  it('reads with no number while the request is pending, and keeps the loaded line', () => {
    harness();
    expect(lines()).toEqual(['2 entities · 0 relationships · loaded · exact', '2 shown · more not yet retrieved']);
  });

  it('reads with no number when the request fails, reports the failure, and keeps the loaded line', async () => {
    const { asks, reported } = harness();
    await answer(asks[0], { ok: false, failure: refused });
    expect(lines()).toEqual(['2 entities · 0 relationships · loaded · exact', '2 shown · more not yet retrieved']);
    expect(reported).toEqual([{ failure: refused, sourceId: 'a' }]);
  });

  it('makes no request when nothing is loaded', () => {
    const { asks } = harness({ nodes: [] });
    expect(asks).toHaveLength(0);
    expect(lines()).toEqual(['0 entities · 0 relationships · loaded · exact', '0 shown · more not yet retrieved']);
  });
});

describe('the second scope line, as the loaded graph changes', () => {
  it('asks again when a preview arrives and shows the new count', async () => {
    const { asks, previewAsks, previews } = harness();
    await answer(asks[0], ok(counted(undefined, 'unknown')));
    act(() => void previews.forNode(ref('a', 'type-a', 'n1'), false));
    await act(async () => previewAsks[0]?.(previewOf()));
    expect(asks).toHaveLength(2);
    await answer(asks[1], ok(counted(4, 'exact')));
    expect(secondLine()).toBe('2 shown · 4 not yet retrieved (exact)');
  });

  it('shows no number until the answer for a replaced graph arrives', async () => {
    const { asks, state } = harness();
    await answer(asks[0], ok(counted(4, 'exact')));
    act(() => load(state, ['x1', 'x2', 'x3'], [], 'seed-2'));
    expect(secondLine()).toBe('3 shown · more not yet retrieved');
    await answer(asks[1], ok(counted(9, 'estimated')));
    expect(secondLine()).toBe('3 shown · ~9 not yet retrieved (estimated)');
  });

  it('keeps the newer answer when an older one arrives after it, and ignores an answer for an earlier graph', async () => {
    const { asks, state } = harness();
    act(() => load(state, ['x1', 'x2', 'x3'], [], 'seed-2'));
    await answer(asks[1], ok(counted(9, 'exact')));
    await answer(asks[0], ok(counted(1, 'exact')));
    expect(secondLine()).toBe('3 shown · 9 not yet retrieved (exact)');
    expect(asks[0]?.signal?.aborted).toBe(true);
  });

  it('makes no further request when nothing changed', async () => {
    const { asks, view, tree } = harness();
    await answer(asks[0], ok(counted(4, 'exact')));
    view.rerender(tree);
    view.rerender(tree);
    expect(asks).toHaveLength(1);
    expect(secondLine()).toBe('2 shown · 4 not yet retrieved (exact)');
  });
});

describe('the relationships loaded at each entity', () => {
  const base = () => {
    const state = createClientState();
    load(state, ['n1', 'n2'], [['e1', 'n1', 'n2'], ['e2', 'n1', 'n1']]);
    return deriveLoadedGraph(state.server.getState(), state.investigation.getState());
  };
  const aggregateOf = (from: string, to: string, members: Count | undefined): GraphEdge => {
    const [any] = base().edges;
    if (any === undefined) throw new Error('no edge');
    return { ...any, ref: { sourceId: 'a', aggregate: { type: 'rel-a', from: ref('a', 'type-a', from), to: ref('a', 'type-a', to) } }, from: ref('a', 'type-a', from), to: ref('a', 'type-a', to), ...(members === undefined ? {} : { memberCount: members }) };
  };
  const derivedOf = (from: string, to: string): GraphEdge => {
    const [any] = base().edges;
    if (any === undefined) throw new Error('no edge');
    return { ...any, ref: { sourceId: 'a', derived: { ruleId: 'r', from: ref('a', 'type-a', from), to: ref('a', 'type-a', to) } }, from: ref('a', 'type-a', from), to: ref('a', 'type-a', to), semantics: 'derived', derivation: { ruleId: 'r', ruleVersion: 1, supportingEdgeRefs: [] } };
  };
  const entitiesOf = (edges: readonly GraphEdge[]) => {
    const graph = base();
    return coverageEntitiesOf({ ...graph, edges }).map((entity) => [entity.ref.stableId, entity.loadedRelationships, entity.loadedQuality]);
  };
  const stored = () => base().edges;

  it('counts a stored relationship once for each of its ends and a stored self-loop twice', () => {
    expect(entitiesOf(stored())).toEqual([['n1', 3, 'exact'], ['n2', 1, 'exact']]);
  });

  it('counts an aggregate by its exact member count at each end, and a self-loop aggregate twice', () => {
    expect(entitiesOf([aggregateOf('n1', 'n2', counted(52, 'exact'))])).toEqual([['n1', 52, 'exact'], ['n2', 52, 'exact']]);
    expect(entitiesOf([aggregateOf('n1', 'n1', counted(5, 'exact'))])).toEqual([['n1', 10, 'exact'], ['n2', 0, 'exact']]);
  });

  it('adds stored and aggregate relationships at the same entity', () => {
    expect(entitiesOf([...stored(), aggregateOf('n1', 'n2', counted(10, 'exact'))])).toEqual([['n1', 13, 'exact'], ['n2', 11, 'exact']]);
  });

  it('marks the ends of an aggregate whose member count is estimated as estimated', () => {
    expect(entitiesOf([aggregateOf('n1', 'n2', counted(8, 'estimated'))])).toEqual([['n1', 8, 'estimated'], ['n2', 8, 'estimated']]);
  });

  it.each([['lower bound', counted(8, 'lowerBound')], ['unknown', counted(undefined, 'unknown')]])('marks the ends of an aggregate whose member count is %s as unknown', (_name, members) => {
    const [first] = entitiesOf([aggregateOf('n1', 'n2', members)]);
    expect(first?.[2]).toBe('unknown');
  });

  it('takes the weakest quality at an entity with several aggregates', () => {
    expect(entitiesOf([aggregateOf('n1', 'n2', counted(8, 'estimated')), aggregateOf('n1', 'n2', counted(2, 'lowerBound'))])[0]?.[2]).toBe('unknown');
  });

  it('counts a derived relationship as nothing', () => {
    expect(entitiesOf([derivedOf('n1', 'n2')])).toEqual([['n1', 0, 'exact'], ['n2', 0, 'exact']]);
  });
});

describe('a loaded graph larger than one request', () => {
  it('sends the entities in chunks of at most the limit, one after another', async () => {
    const { asks } = harness({ nodes: ids(1200) });
    expect(asks).toHaveLength(1);
    expect(asks[0]?.request.entities).toHaveLength(COVERAGE_MAX_ENTITIES);
    await answer(asks[0], ok(counted(0, 'exact')));
    expect(asks).toHaveLength(2);
    await answer(asks[1], ok(counted(0, 'exact')));
    await answer(asks[2], ok(counted(7, 'exact')));
    expect(asks.map((ask) => ask.request.entities.length)).toEqual([500, 500, 200]);
    expect(secondLine()).toBe('1,200 shown · 7 not yet retrieved (exact)');
  });

  it('joins the answers by the rules of quality: two chunks with something left give an estimate', async () => {
    const { asks } = harness({ nodes: ids(600) });
    await answer(asks[0], ok(counted(3, 'exact')));
    await answer(asks[1], ok(counted(4, 'exact')));
    expect(secondLine()).toBe('600 shown · ~7 not yet retrieved (estimated)');
  });

  it('reads with no number, reports the failure and sends no more chunks when a middle chunk fails', async () => {
    const { asks, reported } = harness({ nodes: ids(1200) });
    await answer(asks[0], ok(counted(0, 'exact')));
    await answer(asks[1], { ok: false, failure: refused });
    expect(asks).toHaveLength(2);
    expect(secondLine()).toBe('1,200 shown · more not yet retrieved');
    expect(reported).toHaveLength(1);
  });

  it('stops sending chunks and drops what it has when the graph changes in flight', async () => {
    const { asks, state } = harness({ nodes: ids(1200) });
    await answer(asks[0], ok(counted(5, 'exact')));
    act(() => load(state, ['x1'], [], 'seed-2'));
    await answer(asks[1], ok(counted(5, 'exact')));
    expect(asks.map((ask) => ask.request.entities.length)).toEqual([500, 500, 1]);
    await answer(asks[2], ok(counted(2, 'exact')));
    expect(secondLine()).toBe('1 shown · 2 not yet retrieved (exact)');
  });
});

describe('a cleared graph', () => {
  it('stops the chunks in flight, so a later failure is not reported and no further chunk is sent', async () => {
    const { asks, state, reported } = harness({ nodes: ids(1200) });
    await answer(asks[0], ok(counted(0, 'exact')));
    act(() => state.setLoaded([], [], []));
    expect(secondLine()).toBe('0 shown · more not yet retrieved');
    await answer(asks[1], { ok: false, failure: refused });
    expect(asks).toHaveLength(2);
    expect(reported).toEqual([]);
  });
});

describe('the scope lines with a filtered count', () => {
  const graphOf = (nodes: number, edges: number) => {
    const state = createClientState();
    load(state, ids(nodes), Array.from({ length: edges }, (_unused, index): [string, string, string] => [`e${index}`, 'n0', 'n0']));
    return deriveLoadedGraph(state.server.getState(), state.investigation.getState());
  };
  const linesOf = (filtered: number, loaded = graphOf(10, 13), notRetrieved = counted(5, 'exact')) => {
    cleanup();
    render(<GraphScopeLines graph={loaded} filtered={filtered} notRetrieved={notRetrieved} />);
    return lines();
  };

  it('puts what filters hide on the first line and the shown entities on the second', () => {
    expect(linesOf(3)).toEqual(['10 entities · 13 relationships · loaded · exact · 3 hidden by filters', '7 shown · 5 not yet retrieved (exact)']);
  });

  it('draws no hidden part when nothing is filtered, and shown equals loaded', () => {
    expect(linesOf(0)).toEqual(['10 entities · 13 relationships · loaded · exact', '10 shown · 5 not yet retrieved (exact)']);
  });

  it('reads shown 0 and the loaded count, never a negative number, when more is filtered than is loaded', () => {
    expect(linesOf(25)).toEqual(['10 entities · 13 relationships · loaded · exact · 10 hidden by filters', '0 shown · 5 not yet retrieved (exact)']);
  });

  it('says every part in words, so no quality rests on colour', () => {
    linesOf(3, graphOf(10, 13), counted(500, 'lowerBound'));
    expect(screen.getByRole('group', { name: 'Graph scope' }).textContent).toContain('lower bound');
  });
});
