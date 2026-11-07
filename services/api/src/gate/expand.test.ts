import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import type { ExpansionPage } from './normalize/expansion.js';
import { EXPAND_NEIGHBORS_ID } from './templates/expand-neighbors.js';
import { expandBranchesOf } from './templates/expand-statement.js';
import { allowlistFromMapping } from './allowlist.js';

const ENTITIES = [
  { type: 'hub', label: 'Hub', stable_id: 'hubId' },
  { type: 'leaf', label: 'Leaf', stable_id: 'leafId' },
  { type: 'other', label: 'Other', stable_id: 'otherId' },
];
const RELATIONSHIPS = [
  { type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId', observed_at: 'seenAt' },
  { type: 'NOTED', from: 'hub', to: 'leaf', observed_at: 'seenAt' },
  { type: 'TIED', from: 'leaf', to: 'hub', stable_id: 'tieId' },
  { type: 'LOOPS', from: 'hub', to: 'hub' },
  { type: 'MET', from: 'hub', to: 'other' },
];

const mappingWith = (overrides: Record<string, unknown> = {}) => parseMapping(fileOf(baseSource({ id: 'demo', entities: ENTITIES, relationships: RELATIONSHIPS, ...overrides })), 'neburyx.yaml');

function rig(answer: (call: ExecuteCall) => ExecuteOutcome = () => ({ status: 'rows', rows: [] }), mapping = mappingWith()) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('no source');
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const parts = testSourceGate(mapping, { executor });
  const indexes = { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) };
  const params = (extra: Record<string, unknown> = {}) => ({ entityType: 'hub', stableId: 'H-1', neighborType: 'leaf', direction: 'both', sort: 'observed', ...extra });
  const read = (extra: Record<string, unknown> = {}, limit = 25, more: Record<string, unknown> = {}) =>
    parts.gate.run(gateRequest({ sourceId: 'demo', templateId: EXPAND_NEIGHBORS_ID, params: params(extra), limit, indexes: indexes as never, ...more }));
  return { ...parts, read, executor, source, params };
}

const dataCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === EXPAND_NEIGHBORS_ID);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

const hub = plainNode(['Hub'], { hubId: 'H-1' }, 'e-hub');
const leaf = (id: string) => plainNode(['Leaf'], { leafId: id }, `e-${id}`);
const when = (text: string) => ({ $type: 'dateTime', value: text });
const storedRow = (phase: number, rel: ReturnType<typeof plainRelationship>, node: ReturnType<typeof leaf>, ts: unknown, id: string, dir = 'out', rtype = 'LINKED') => ({ a: hub, m: node, rel, phase, tk: ts === null ? null : 1, ts, id, rtype, dir, ntype: null, flag: null, members: null, first: null });
const aggregateRow = (phase: number, node: ReturnType<typeof leaf>, ts: unknown, members: number, dir = 'out', rtype = 'NOTED') => ({ a: hub, m: node, rel: null, phase, tk: ts === null ? null : 1, ts, id: String(node.properties['leafId']), rtype, dir, ntype: 'leaf', flag: null, members, first: ts });
const pageOf = (item: unknown): ExpansionPage => item as ExpansionPage;

describe('the branches of an expansion', () => {
  const allowlist = allowlistFromMapping(mappingWith().sources[0] ?? (() => { throw new Error('no source'); })());

  it('are the mapping rows that join the two entity types, one for each direction asked', () => {
    expect(expandBranchesOf(allowlist, 'hub', 'leaf', undefined, 'both').map((branch) => `${branch.type}:${branch.direction}`)).toEqual(['LINKED:out', 'NOTED:out', 'TIED:in']);
    expect(expandBranchesOf(allowlist, 'hub', 'leaf', undefined, 'out').map((branch) => branch.type)).toEqual(['LINKED', 'NOTED']);
    expect(expandBranchesOf(allowlist, 'hub', 'leaf', ['TIED'], 'both').map((branch) => branch.type)).toEqual(['TIED']);
    expect(expandBranchesOf(allowlist, 'hub', 'other', undefined, 'in')).toEqual([]);
  });

  it('read a relationship from a node to itself once, as out, when both directions are asked', () => {
    const both = expandBranchesOf(allowlist, 'hub', 'hub', undefined, 'both');
    expect(both.map((branch) => `${branch.direction}:${branch.excludesLoops}`)).toEqual(['out:false', 'in:true']);
    expect(expandBranchesOf(allowlist, 'hub', 'hub', undefined, 'in').map((branch) => branch.excludesLoops)).toEqual([false]);
  });
});

describe('the statement of an expansion', () => {
  it('writes quoted names from the mapping and passes every value as a parameter', async () => {
    const { read, executor } = rig();
    await read();
    const [call] = dataCalls(executor);
    expect(call?.cypher).toContain('MATCH (a:`Hub`) WHERE a.`hubId` IN [$stableId, $stableInteger] WITH a ORDER BY elementId(a) LIMIT 1');
    expect(call?.cypher).toContain('(a)-[r:`LINKED`]->(m:`Leaf`)');
    expect(call?.cypher).toContain('(a)<-[r:`TIED`]-(m:`Leaf`)');
    expect(call?.cypher).toContain('r.`seenAt`');
    expect(call?.cypher).toMatch(/LIMIT \$limit \+ 1\s*$/);
    expect(call?.cypher).not.toContain('H-1');
    expect(call?.parameters).toMatchObject({ stableId: 'H-1', neighborType: 'leaf', limit: 25, cursor: null });
    expect(call?.accessMode).toBe('READ');
  });

  it('has a branch for the dated rows, the undated rows and the rows without a usable ID', async () => {
    const { read, executor } = rig();
    await read();
    const [call] = dataCalls(executor);
    for (const phase of ['0 AS phase', '1 AS phase', '2 AS phase', '3 AS phase']) expect(call?.cypher).toContain(phase);
    expect(call?.cypher).toContain("'no-stable-id' AS flag");
    expect(call?.cypher).toContain('count(r) AS members');
  });

  it('refuses a name that the mapping does not hold, and reads nothing', async () => {
    const { read, executor } = rig();
    expect(await codeOf(read({ neighborType: 'nothing' }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ entityType: 'nothing' }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ relTypes: ['KNOWS`) DETACH DELETE (n'] }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ relTypes: ['LINKED', 'LINKED'] }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ direction: 'sideways' }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ extra: 1 }))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toEqual([]);
  });

  it('reads nothing for a pair no mapping row joins and answers an empty page', async () => {
    const { read, executor } = rig();
    const page = await read({ neighborType: 'other', direction: 'in' });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(dataCalls(executor)).toEqual([]);
  });
});

describe('the page size of an expansion', () => {
  it.each([[0, 'INVALID_REQUEST'], [-3, 'INVALID_REQUEST'], [1.5, 'INVALID_REQUEST'], [51, 'QUERY_BUDGET_EXCEEDED'], [1_000_000, 'QUERY_BUDGET_EXCEEDED']])('refuses %s with %s and reads nothing', async (limit, code) => {
    const { read, executor } = rig();
    expect(await codeOf(read({}, limit))).toBe(code);
    expect(dataCalls(executor)).toEqual([]);
  });

  it('follows the budgets the source configures', async () => {
    const { read, executor } = rig(undefined, mappingWith({ budgets: { max_page: 10, default_page: 10 } }));
    expect(await codeOf(read({}, 11))).toBe('QUERY_BUDGET_EXCEEDED');
    expect(await codeOf(read({}, 10))).toBe('ok');
    expect(dataCalls(executor)).toHaveLength(1);
  });
});

describe('the pages and cursors of an expansion', () => {
  const rows = (count: number) => Array.from({ length: count }, (_, index) => storedRow(0, plainRelationship('LINKED', hub, leaf(`l${index}`), { relId: `r${index}`, seenAt: when(`2026-01-01T10:00:0${index}Z`) }, `rel-${index}`), leaf(`l${index}`), when(`2026-01-01T10:00:0${9 - index}Z`), `r${index}`));

  it('answers the edges in the order of the rows and signs a cursor from the last row when there is more', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: rows(3) }));
    const page = await read({}, 2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toMatch(/^v1\./);
    const item = pageOf(page.items[0]);
    expect(item.edges.map((edge) => 'stableId' in edge.ref && edge.ref.stableId)).toEqual(['r0', 'r1']);
    expect(item.edges.every((edge) => edge.direction === 'out')).toBe(true);
  });

  it('gives no cursor on the last page', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: rows(2) }));
    const page = await read({}, 2);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it('passes the position of the cursor as the keyset parameter, with its kind, and reads the next page from it', async () => {
    const { read, executor } = rig(() => ({ status: 'rows', rows: rows(3) }));
    const first = await read({}, 2);
    await read({}, 2, { cursor: first.nextCursor });
    const calls = dataCalls(executor);
    expect(calls[0]?.parameters['cursor']).toBeNull();
    expect(calls[1]?.parameters['cursor']).toEqual({ phase: 0, ts: '2026-01-01T10:00:08Z', tk: 1, id: 'r1', rtype: 'LINKED', dir: 'out', nType: null });
  });

  it('refuses, as CURSOR_INVALIDATED and before any read, a cursor used for another node, neighbor type, direction, relationship types or masking', async () => {
    const { read, executor } = rig(() => ({ status: 'rows', rows: rows(3) }));
    const cursor = (await read({}, 2)).nextCursor;
    const before = dataCalls(executor).length;
    for (const change of [{ stableId: 'H-2' }, { neighborType: 'other' }, { direction: 'out' }, { relTypes: ['LINKED'] }]) {
      expect(await codeOf(read(change, 2, { cursor }))).toBe('CURSOR_INVALIDATED');
    }
    expect(await codeOf(read({}, 2, { cursor, mask: true }))).toBe('CURSOR_INVALIDATED');
    expect(await codeOf(read({}, 2, { cursor: `${cursor}x` }))).toBe('CURSOR_INVALIDATED');
    expect(await codeOf(read({}, 2, { cursor: 'garbage' }))).toBe('CURSOR_INVALIDATED');
    expect(dataCalls(executor)).toHaveLength(before);
  });

  it('accepts the cursor on a request with another page size', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: rows(3) }));
    const cursor = (await read({}, 2)).nextCursor;
    expect(await codeOf(read({}, 5, { cursor }))).toBe('ok');
  });

  it('holds the neighbor type in the cursor of an aggregate, so a keyed neighbor is held as its token', async () => {
    const aggregates = [aggregateRow(1, leaf('l1'), when('2026-04-02T00:00:00Z'), 3), aggregateRow(1, leaf('l2'), when('2026-04-01T00:00:00Z'), 2)];
    const { read, executor } = rig(() => ({ status: 'rows', rows: aggregates }));
    const first = await read({}, 1);
    await read({}, 1, { cursor: first.nextCursor });
    expect(dataCalls(executor)[1]?.parameters['cursor']).toMatchObject({ phase: 1, id: 'l1', nType: 'leaf', dir: 'out', rtype: 'NOTED' });
  });
});

describe('the answer of an expansion', () => {
  it('holds the anchor, the neighbors and an aggregate edge with its member count, observed times and direction', async () => {
    const neighbor = leaf('l1');
    const rows = [storedRow(0, plainRelationship('LINKED', hub, neighbor, { relId: 'r1' }, 'rel-1'), neighbor, when('2026-01-01T10:00:00Z'), 'r1'), aggregateRow(1, leaf('l2'), when('2026-04-02T00:00:00Z'), 3)];
    const { read } = rig(() => ({ status: 'rows', rows }));
    const item = pageOf((await read()).items[0]);
    expect(item.anchorFound).toBe(true);
    expect(item.nodes.map((node) => node.ref.stableId).sort()).toEqual(['H-1', 'l1', 'l2']);
    expect(item.edges[1]).toMatchObject({ type: 'NOTED', direction: 'out', memberCount: { value: 3, quality: 'exact' }, observedFirst: '2026-04-02T00:00:00Z', observedLast: '2026-04-02T00:00:00Z' });
    expect(item.edges[1]?.ref).toHaveProperty('aggregate');
  });

  it('marks the direction of an edge that enters the node as in', async () => {
    const neighbor = leaf('l1');
    const rows = [storedRow(2, plainRelationship('TIED', neighbor, hub, { tieId: 't1' }, 'rel-t'), neighbor, null, 't1', 'in', 'TIED')];
    const { read } = rig(() => ({ status: 'rows', rows }));
    const item = pageOf((await read({ relTypes: ['TIED'] })).items[0]);
    expect(item.edges).toHaveLength(1);
    expect(item.edges[0]).toMatchObject({ direction: 'in', type: 'TIED', from: { entityType: 'leaf' }, to: { entityType: 'hub' } });
  });

  it('says the anchor is absent when the read returns no row at all', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: [] }));
    expect(pageOf((await read()).items[0]).anchorFound).toBe(false);
  });

  it('keeps the page when a row has no relationship: the anchor is found and the page is empty', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: [{ a: hub, m: null, rel: null, phase: null }] }));
    const item = pageOf((await read()).items[0]);
    expect(item.anchorFound).toBe(true);
    expect(item.edges).toEqual([]);
  });
});

describe('the rows an expansion cannot show', () => {
  it('accounts for every row exactly once: a stored edge, a folded duplicate, an aggregate edge, or a count under a named reason', async () => {
    const stranger = plainNode(['Stranger'], { id: 's' }, 'e-stranger');
    const l1 = leaf('l1');
    const l2 = leaf('l2');
    const rows = [
      storedRow(0, plainRelationship('LINKED', hub, l1, { relId: 'dup' }, 'rel-1'), l1, when('2026-01-02T00:00:00Z'), 'dup'),
      storedRow(0, plainRelationship('LINKED', hub, l1, { relId: 'dup' }, 'rel-2'), l1, when('2026-01-01T00:00:00Z'), 'dup'),
      storedRow(0, plainRelationship('LINKED', hub, stranger, { relId: 'x' }, 'rel-3'), { ...stranger, labels: ['Stranger'] } as never, when('2025-01-01T00:00:00Z'), 'x'),
      aggregateRow(1, l2, when('2024-01-01T00:00:00Z'), 4),
      aggregateRow(1, { ...stranger } as never, when('2023-01-01T00:00:00Z'), 5),
    ];
    const { read } = rig(() => ({ status: 'rows', rows }));
    const item = pageOf((await read()).items[0]);
    const folded = item.edges.filter((edge) => edge.qualityFlags.includes('conflicting-duplicate'));
    const aggregates = item.edges.filter((edge) => 'aggregate' in edge.ref);
    expect(folded).toHaveLength(1);
    expect(aggregates).toHaveLength(1);
    expect(item.dropped['end-not-shown']).toBe(1 + 5);
    const storedRows = 3;
    expect(item.edges.length - aggregates.length + 1 /* the folded duplicate */ + 1 /* the dropped stored row */).toBe(storedRows);
    expect(item.warnings.some((warning) => warning.includes('one of their ends was left out'))).toBe(true);
  });

  it('keeps a relationship to a neighbor of a type whose label another type shares, because the read names the type', async () => {
    const shared = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'hub', label: 'Hub', stable_id: 'hubId' }, { type: 'leaf', label: 'Thing', stable_id: 'leafId' }, { type: 'twin', label: 'Thing', stable_id: 'twinId' }], relationships: [{ type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId' }] })), 'neburyx.yaml');
    const neighbor = plainNode(['Thing'], { leafId: 'l1' }, 'e-l1');
    const rows = [{ a: hub, m: neighbor, rel: plainRelationship('LINKED', hub, neighbor, { relId: 'r1' }, 'rel-1'), phase: 2, ts: null, id: 'r1', rtype: 'LINKED', dir: 'out', ntype: null, flag: null, members: null, first: null }];
    const { read } = rig(() => ({ status: 'rows', rows }), shared);
    const item = pageOf((await read()).items[0]);
    expect(item.edges).toHaveLength(1);
    expect(item.nodes.map((node) => node.ref.entityType).sort()).toEqual(['hub', 'leaf']);
    expect(item.dropped['ambiguous-type']).toBe(0);
  });
});

describe('the accounting of the rows of an expansion', () => {
  const stranger = plainNode(['Stranger'], { id: 's' }, 'e-stranger');

  /** A small deterministic generator, so a failing case can be replayed. */
  const generator = (seed: number) => () => {
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return seed / 4_294_967_296;
  };

  it('accounts for every stored row and every aggregate member exactly once, over many generated pages', async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = generator(seed);
      const rows: Record<string, unknown>[] = [];
      let storedShown = 0;
      let membersShown = 0;
      let rowsDropped = 0;
      const keys = new Set<string>();
      const seen = new Map<string, number>();
      const count = 1 + Math.floor(next() * 12);
      for (let index = 0; index < count; index += 1) {
        const hidden = next() < 0.25;
        const end = hidden ? stranger : leaf(`l${Math.floor(next() * 5)}`);
        if (next() < 0.5) {
          const id = `id${Math.floor(next() * 6)}`;
          rows.push(storedRow(0, plainRelationship('LINKED', hub, end, { relId: id }, `rel-${seed}-${index}`), end, when('2026-01-01T00:00:00Z'), id));
          if (hidden) {
            rowsDropped += 1;
          } else {
            seen.set(id, (seen.get(id) ?? 0) + 1);
            if (!keys.has(id)) {
              keys.add(id);
              storedShown += 1;
            }
          }
        } else {
          const members = 1 + Math.floor(next() * 9);
          rows.push(aggregateRow(1, end, when('2026-02-01T00:00:00Z'), members));
          if (hidden) rowsDropped += members;
          else membersShown += members;
        }
      }
      const { read } = rig(() => ({ status: 'rows', rows }));
      const item = pageOf((await read({}, 50)).items[0]);
      const stored = item.edges.filter((edge) => !('aggregate' in edge.ref));
      const aggregates = item.edges.filter((edge) => 'aggregate' in edge.ref);
      const edgeDropped = (item.dropped['end-not-shown'] ?? 0) + (item.dropped['end-missing'] ?? 0) + (item.dropped['no-mapping-row'] ?? 0);
      expect(stored.length, `seed ${seed}`).toBe(storedShown);
      expect(stored.filter((edge) => edge.qualityFlags.includes('conflicting-duplicate')).length, `seed ${seed}`).toBe([...seen.values()].filter((times) => times > 1).length);
      expect(aggregates.reduce((sum, edge) => sum + (edge.memberCount?.value ?? 0), 0), `seed ${seed}`).toBe(membersShown);
      expect(edgeDropped, `seed ${seed}`).toBe(rowsDropped);
    }
  });
});

describe('duplicate relationship IDs across a page boundary', () => {
  it('can be skipped when they share the cursor\'s sort value and ID: no read of the returned pages can see it, so no gap-free claim is made without a uniqueness constraint', async () => {
    const sameTime = when('2026-01-01T00:00:00Z');
    const stored = [
      storedRow(0, plainRelationship('LINKED', hub, leaf('l1'), { relId: 'dup' }, 'rel-1'), leaf('l1'), sameTime, 'dup'),
      storedRow(0, plainRelationship('LINKED', hub, leaf('l2'), { relId: 'dup' }, 'rel-2'), leaf('l2'), sameTime, 'dup'),
      storedRow(0, plainRelationship('LINKED', hub, leaf('l3'), { relId: 'next' }, 'rel-3'), leaf('l3'), when('2025-12-31T00:00:00Z'), 'next'),
    ];
    const { read } = rig((call) => {
      const after = call.parameters['cursor'];
      const afterId = typeof after === 'object' && after !== null && 'id' in after ? String(after['id']) : undefined;
      // the keyset predicate of the template: rows strictly after the cursor's (sort value, ID)
      const remaining = afterId === undefined ? stored : stored.filter((row) => row.id < afterId || (row.id !== afterId && row.ts !== sameTime));
      return { status: 'rows', rows: remaining.slice(0, call.rowLimit) };
    });
    const first = await read({}, 1);
    const second = await read({}, 1, { cursor: first.nextCursor });
    const seen = [first, second].flatMap((page) => pageOf(page.items[0]).edges.map((edge) => ('stableId' in edge.ref ? edge.ref.stableId : '')));
    expect(seen).toEqual(['dup', 'next']);
    expect(stored.filter((row) => row.id === 'dup')).toHaveLength(2);
  });
});
