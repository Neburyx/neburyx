/*
 * The supernode suite: one file, so the anchors of 1,000, 10,000 and 100,000 relationships of each of four types are built once per run
 * (`startRig`) and shared by every case, and the database is dropped when the file ends.
 *
 * Time: the run measured on the dev 5.26 server took about 12 minutes, the build of the anchors included. The slowest cases walk the whole order of "all" at 10,000 relationships (31,000 rows)
 * twice, by pages of 25 and of 50, and 200 pages of 25 at 100,000. The hook gets an hour; a case has the timeout it states (10 to 60 minutes) or the 30 minutes of the config.
 */
import { degreePreviewSchema, type DegreePreview } from '@neburyx/contracts';
import neo4j from 'neo4j-driver';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { AppError } from '../../errors.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../gate.js';
import { createSourceGate, type SourceGate } from '../../gate/source-gate.js';
import { communitySeams } from '../../seams/community-seams.js';
import { DEGREE_PREVIEW_BOUNDED_ID, DEGREE_PREVIEW_CHEAP_ID } from '../../gate/templates/degree-preview.js';
import { notRetrievedOf } from '../../graph/coverage-sum.js';
import { createLogger } from '../../logger.js';
import { memoryAppStore } from '../app-store.js';
import { ENTITIES, hubOf, RELATIONSHIPS } from '../benchmark/fixture.js';
import { READ_SETS, rowsOf, SIZES, WALK_PAGE, type ReadSet } from '../benchmark/plan.js';
import { startRig, stopRig, type Rig } from '../benchmark/rig.js';
import { envFor, NEO4J_SERIES, runAdmin, sourceFor } from '../neo4j-server.js';
import { makeWebRoot } from '../web-root.js';
import type { CursorPosition } from '../../gate/cursor/codec.js';
import { execFileSync } from 'node:child_process';
import { profileReadSet } from '../benchmark/profile.js';
import { dbHitCauseFor } from '../benchmark/db-hit-cause.js';
import { performance } from 'node:perf_hooks';
import { writeCostRecord, type PageCost } from './cost.js';
import { checkCountLabel } from './labels.js';
import { checkPageBounds, checkPreviewBounds, MAX_PAGE, PAGE, PAGE_BYTES } from './bounds.js';
import { cursorAtRow, keyOfEdge, readPage } from './pages.js';
import { expectedOrder, labelOf } from './order.js';
import { checkSameSequence, checkWalk, timeOf, type WalkedPage } from './walk.js';

/** The commit the code is at, with `-dirty` when the tree has changes: a record must not name a commit whose code did not run. */
function commitOf(): string {
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  return execFileSync('git', ['status', '--porcelain']).toString().trim() === '' ? commit : `${commit}-dirty`;
}

const webRoot = makeWebRoot();
let rig: Rig;

/** The dated read set of the largest anchor, after 200 pages of 25: walked once by the file and used by every case that needs a deep position there. */
const DEEP_PAGES = 200;
interface Deep {
  readonly keys: readonly string[];
  readonly cursor: string | undefined;
  /** The position of the last cursor, taken as soon as the walk ends: the rig remembers only the latest cursors. */
  readonly position: CursorPosition | undefined;
}
let deep: Promise<Deep> | undefined;
async function walkDeep(): Promise<Deep> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < DEEP_PAGES; index += 1) {
    const page = await readPage(rig.parts.gate, 100_000, 'dated', PAGE, cursor);
    keys.push(...page.item.edges.map(keyOfEdge));
    cursor = page.nextCursor;
  }
  return { keys, cursor, position: cursor === undefined ? undefined : rig.positionOf(cursor) };
}
const deepWalk = (): Promise<Deep> => (deep ??= walkDeep());

beforeAll(async () => {
  rig = await startRig();
}, 3_600_000);

afterAll(async () => {
  rmSync(webRoot, { recursive: true, force: true });
  await stopRig(rig);
});

/** The row of the page at 50% of the order, on a boundary of the walk page. */
const halfwayOf = (set: ReadSet, size: number): number => Math.floor((rowsOf(set, size) * 0.5) / WALK_PAGE) * WALK_PAGE;

describe(`payloads of a supernode on ${NEO4J_SERIES}`, () => {
  for (const size of SIZES) {
    it(`bounds the first page of each read set at ${size.toLocaleString('en')} relationships`, async () => {
      for (const set of READ_SETS) {
        const page = await readPage(rig.parts.gate, size, set, PAGE);
        expect(page.item.edges).toHaveLength(PAGE);
        expect(page.hasMore).toBe(true);
        expect(page.nextCursor).toBeDefined();
        checkPageBounds(page.item, PAGE, `${set} at ${size}, first page`);
      }
    }, 600_000);
  }

  for (const size of [1_000, 10_000]) {
    it(`bounds the page at 50% of the order of each read set at ${size.toLocaleString('en')} relationships, reached by the real chain`, async () => {
      for (const set of READ_SETS) {
        const cursor = await cursorAtRow(rig.parts.gate, size, set, halfwayOf(set, size));
        const page = await readPage(rig.parts.gate, size, set, PAGE, cursor);
        expect(page.item.edges).toHaveLength(PAGE);
        checkPageBounds(page.item, PAGE, `${set} at ${size}, 50%`);
      }
    }, 1_800_000);
  }

  it('bounds a deep page of the dated read set at 100,000 relationships, reached by the real chain', async () => {
    const page = await readPage(rig.parts.gate, 100_000, 'dated', PAGE, (await deepWalk()).cursor);
    expect(page.item.edges).toHaveLength(PAGE);
    expect(page.hasMore).toBe(true);
    checkPageBounds(page.item, PAGE, 'dated at 100000, row 5000');
  }, 1_800_000);

  it('rejects a response altered to hold one edge more than the page, and one over the byte limit', async () => {
    const page = await readPage(rig.parts.gate, 1_000, 'dated', PAGE);
    const extra = page.item.edges[0];
    if (extra === undefined) throw new Error('no edge');
    expect(() => checkPageBounds({ edges: [...page.item.edges, extra], nodes: page.item.nodes }, PAGE, 'altered')).toThrow(`${PAGE + 1} edges, over the page of ${PAGE}`);
    expect(() => checkPageBounds({ edges: page.item.edges, nodes: page.item.nodes }, PAGE, 'altered', 10)).toThrow('not under the limit of 10');
  });

  it(`answers a page of ${MAX_PAGE + 1} with QUERY_BUDGET_EXCEEDED and the maximum, and no row`, async () => {
    const error = await readPage(rig.parts.gate, 100_000, 'dated', MAX_PAGE + 1).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxPage: MAX_PAGE } });
  });
});

describe(`the degree preview of a supernode on ${NEO4J_SERIES}`, () => {
  it('answers each anchor with its counts by type and direction and no neighbor list, under the size bound', async () => {
    const mapping = { sources: [sourceFor(rig.server, { entities: ENTITIES, relationships: RELATIONSHIPS })] };
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: rig.parts.gate });
    try {
      for (const size of SIZES) {
        const response = await app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload: { sourceId: 'graph', ref: { entityType: 'hub', stableId: hubOf(size) } } });
        expect(response.statusCode).toBe(200);
        const preview = degreePreviewSchema.parse(response.json());
        expect(preview.byType.map((entry) => `${entry.relationshipType} ${entry.direction}`).sort()).toEqual(['LINKED out', 'NOTED out', 'PAID out', 'TIED out']);
        for (const entry of preview.byType) expect(entry.neighborTypes).toEqual(['leaf']);
        expect(preview.byNeighborType.length).toBeGreaterThan(0);
        checkPreviewBounds(preview, `preview at ${size}`);
      }
    } finally {
      await app.close();
    }
  }, 600_000);
});

const CAP = 500;
const LEAVES = 'MATCH (h:BenchHub {hubId: $hub}) UNWIND range(1, $count) AS i CREATE (h)-[:LINKED]->(:BenchLeaf {leafId: $hub + "-" + toString(i)})';

/** A gate over the database of the run with its own mapping; closed with the file. */
const extraGates: SourceGate[] = [];
function gateWith(overrides: Record<string, unknown>): SourceGate {
  const defaults = communitySeams();
  const parts = createSourceGate({ mapping: { sources: [sourceFor(rig.server, overrides)] }, env: envFor(rig.server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
  extraGates.push(parts);
  return parts;
}

async function endpointPreview(parts: SourceGate, mapping: Record<string, unknown>, stableId: string): Promise<DegreePreview> {
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping: { sources: [sourceFor(rig.server, mapping)] }, gate: parts.gate });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload: { sourceId: 'graph', ref: { entityType: 'hub', stableId } } });
    expect(response.statusCode).toBe(200);
    return degreePreviewSchema.parse(response.json());
  } finally {
    await app.close();
  }
}

const countsOf = (preview: DegreePreview) => preview.byType.map((entry) => entry.count);

describe(`the counts of a supernode on ${NEO4J_SERIES}`, () => {
  const plain = { entities: ENTITIES, relationships: RELATIONSHIPS };
  const withDegree = {
    entities: [{ ...ENTITIES[0], degree: [{ type: 'LINKED', direction: 'out', property: 'linkDegree', observed_at: 'linkDegreeAt' }] }, ENTITIES[1]],
    relationships: RELATIONSHIPS,
  };
  const twoNeighborTypes = {
    entities: [...ENTITIES, { type: 'other', label: 'BenchOther', stable_id: 'otherId' }],
    relationships: [...RELATIONSHIPS, { type: 'LINKED', from: 'hub', to: 'other' }],
  };

  beforeAll(async () => {
    await runAdmin(rig.server, `CREATE (:BenchHub {hubId: 'count-500'}), (:BenchHub {hubId: 'count-501'}), (:BenchHub {hubId: 'estimated', linkDegree: 1200, linkDegreeAt: date('2026-01-02')}), (:BenchHub {hubId: 'undeclared'}), (:BenchHub {hubId: 'two-types'})`);
    for (const [hub, count] of [['count-500', CAP], ['count-501', CAP + 1], ['estimated', CAP + 1], ['undeclared', CAP + 1], ['two-types', 3]] as const) {
      await runAdmin(rig.server, LEAVES, { hub, count: neo4j.int(count) });
    }
    await runAdmin(rig.server, "CREATE (:BenchOther {otherId: 'o1'})");
  }, 600_000);

  afterAll(async () => {
    // a gate that fails to close must not hide the result of a case, and the database is dropped by the rig whatever happens
    for (const parts of extraGates) await parts.close().catch(() => undefined);
  });

  const countOf = async (parts: SourceGate, templateId: string, stableId: string) => {
    const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId, params: { entityType: 'hub', stableId }, limit: 1 }));
    // the degree templates return rows of this shape (see degree-preview.neo4j.test.ts)
    return page.items[0] as unknown as { found: boolean; counts: { value: number; quality: string }[] };
  };

  it('labels the bounded read of every anchor lowerBound at the cap, and the cheap read exact at the size', async () => {
    for (const size of SIZES) {
      const bounded = await countOf(rig.parts, DEGREE_PREVIEW_BOUNDED_ID, hubOf(size));
      expect(bounded.counts).toHaveLength(4);
      for (const count of bounded.counts) expect(count).toMatchObject({ value: CAP, quality: 'lowerBound' });
      const cheap = await countOf(rig.parts, DEGREE_PREVIEW_CHEAP_ID, hubOf(size));
      for (const count of cheap.counts) expect(count).toEqual({ value: size, quality: 'exact' });
    }
  });

  it('labels a node of exactly the cap exact and one above it lowerBound at the cap', async () => {
    expect((await countOf(rig.parts, DEGREE_PREVIEW_BOUNDED_ID, 'count-500')).counts[0]).toEqual({ value: CAP, quality: 'exact' });
    expect((await countOf(rig.parts, DEGREE_PREVIEW_BOUNDED_ID, 'count-501')).counts[0]).toEqual({ value: CAP, quality: 'lowerBound' });
  });

  it('labels the count of a node with a declared degree property estimated, with the date of the mapping, and never when it is not declared or the read is cheap', async () => {
    const declared = gateWith(withDegree);
    const preview = await endpointPreview(declared, withDegree, 'estimated');
    const linked = preview.byType.find((entry) => entry.relationshipType === 'LINKED')?.count;
    expect(linked).toMatchObject({ value: 1200, quality: 'estimated', observedAt: '2026-01-02' });
    checkCountLabel(linked, 'estimated count');
    expect((await endpointPreview(rig.parts, plain, 'undeclared')).byType.find((entry) => entry.relationshipType === 'LINKED')?.count).toMatchObject({ value: CAP, quality: 'lowerBound' });
    expect((await countOf(declared, DEGREE_PREVIEW_CHEAP_ID, 'estimated')).counts[0]).toEqual({ value: CAP + 1, quality: 'exact' });
  });

  it('labels the count by neighbor type unknown, with no value, when a relationship type reaches two neighbor types', async () => {
    const preview = await endpointPreview(gateWith(twoNeighborTypes), twoNeighborTypes, 'two-types');
    const unknown = preview.byNeighborType.filter((entry) => entry.count.quality === 'unknown');
    expect(unknown.map((entry) => entry.entityType).sort()).toEqual(['leaf', 'other']);
    for (const entry of unknown) {
      expect(entry.count.value).toBeUndefined();
      checkCountLabel(entry.count, 'neighbor count');
    }
  });

  it('answers an anchor the source does not hold with NOT_FOUND and no count', async () => {
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping: { sources: [sourceFor(rig.server, plain)] }, gate: rig.parts.gate });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload: { sourceId: 'graph', ref: { entityType: 'hub', stableId: 'nobody' } } });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(response.json()).not.toHaveProperty('byType');
    } finally {
      await app.close();
    }
  });

  it('labels every count of every anchor and hands the lower bound to the not-yet-retrieved sum with its quality', async () => {
    for (const size of SIZES) {
      const preview = await endpointPreview(rig.parts, plain, hubOf(size));
      for (const count of [...countsOf(preview), preview.total, ...preview.byNeighborType.map((entry) => entry.count)]) checkCountLabel(count, `preview at ${size}`);
      expect(preview.total).toMatchObject({ value: 4 * CAP, quality: 'lowerBound' });
      const sum = notRetrievedOf([{ preview, loadedRelationships: PAGE, loadedQuality: 'exact' }]);
      expect(sum).toMatchObject({ value: 4 * CAP - PAGE, quality: 'lowerBound' });
    }
  }, 600_000);
});

/** The relationships each read set stands for, per relationship of one type on the anchor. */
const TYPES_OF: Readonly<Record<ReadSet, number>> = { dated: 1, undated: 1, aggregate: 1, plain: 1, all: 4 };

async function walkWhole(size: number, set: ReadSet, limit: number): Promise<WalkedPage[]> {
  const pages: WalkedPage[] = [];
  let cursor: string | undefined;
  do {
    const page = await readPage(rig.parts.gate, size, set, limit, cursor);
    pages.push({ edges: page.item.edges, hasMore: page.hasMore });
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return pages;
}

describe(`the order of a supernode on ${NEO4J_SERIES}`, () => {
  for (const size of [1_000, 10_000]) {
    for (const set of READ_SETS) {
      it(`reaches every row of the ${set} read set once at ${size.toLocaleString('en')} relationships, the same whatever the page size`, async () => {
        const expected = { rows: rowsOf(set, size), relationships: TYPES_OF[set] * size };
        const small = await walkWhole(size, set, PAGE);
        const keys = checkWalk(small, expected, `${set} at ${size}, pages of ${PAGE}`);
        checkSameSequence(small.flatMap((page) => page.edges.map(labelOf)), expectedOrder(set, size), `${set} at ${size}, the order of the fixture`);
        const times = small.flatMap((page) => page.edges.flatMap((edge) => (timeOf(edge) === undefined ? [] : [Date.parse(timeOf(edge) ?? '')])));
        if (set === 'dated') expect(times).toHaveLength(expected.rows);
        if (set === 'dated') for (let index = 1; index < times.length; index += 1) expect(times[index]).toBeLessThanOrEqual(times[index - 1] ?? 0);
        checkSameSequence(keys, checkWalk(await walkWhole(size, set, WALK_PAGE), expected, `${set} at ${size}, pages of ${WALK_PAGE}`), `${set} at ${size}, ${PAGE} against ${WALK_PAGE}`);
      }, 3_600_000);
    }
  }

  it('reaches 5,000 rows of the dated read set at 100,000 relationships by 200 pages without a repeat, and the next page repeats none of them', async () => {
    const { keys, cursor } = await deepWalk();
    expect(keys).toHaveLength(DEEP_PAGES * PAGE);
    expect(new Set(keys).size).toBe(keys.length);
    const next = await readPage(rig.parts.gate, 100_000, 'dated', PAGE, cursor);
    expect(next.item.edges).toHaveLength(PAGE);
    for (const edge of next.item.edges) expect(keys).not.toContain(keyOfEdge(edge));
  }, 1_800_000);

  it('answers CURSOR_INVALIDATED and no row to a cursor with one character altered', async () => {
    const first = await readPage(rig.parts.gate, 1_000, 'dated', PAGE);
    const cursor = first.nextCursor;
    if (cursor === undefined) throw new Error('no cursor');
    const at = Math.floor(cursor.length / 2);
    const altered = `${cursor.slice(0, at)}${cursor[at] === 'A' ? 'B' : 'A'}${cursor.slice(at + 1)}`;
    const error = await readPage(rig.parts.gate, 1_000, 'dated', PAGE, altered).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'CURSOR_INVALIDATED' });
  });
});

describe(`the cost of each page on ${NEO4J_SERIES}`, () => {
  it('is recorded for the first page of every read set at each size and the deep pages of the plan, with the db hits of one profile of each', async () => {
    const pages: PageCost[] = [];
    const take = async (size: number, set: ReadSet, position: string, cursor: string | undefined): Promise<void> => {
      const cursorPosition = cursor === undefined ? undefined : rig.positionOf(cursor);
      const started = performance.now();
      const page = await readPage(rig.parts.gate, size, set, PAGE, cursor);
      const ms = performance.now() - started;
      checkPageBounds(page.item, PAGE, `${set} at ${size}, ${position}`);
      const profile = await profileReadSet(rig.server, size, set, position, cursorPosition);
      pages.push({ size, readSet: set, position, ms, edges: page.item.edges.length, bytes: JSON.stringify(page.item).length, dbHits: profile.dbHits });
    };
    for (const size of SIZES) for (const set of READ_SETS) await take(size, set, 'first', undefined);
    for (const size of [1_000, 10_000]) {
      for (const set of READ_SETS) {
        const cursor = await cursorAtRow(rig.parts.gate, size, set, halfwayOf(set, size));
        await take(size, set, '50%', cursor);
      }
    }
    const { cursor, position } = await deepWalk();
    const started = performance.now();
    const page = await readPage(rig.parts.gate, 100_000, 'dated', PAGE, cursor);
    const ms = performance.now() - started;
    const profile = await profileReadSet(rig.server, 100_000, 'dated', 'row 5000', position);
    pages.push({ size: 100_000, readSet: 'dated', position: 'row 5000', ms, edges: page.item.edges.length, bytes: JSON.stringify(page.item).length, dbHits: profile.dbHits });
    expect(pages.every((entry) => entry.edges === PAGE)).toBe(true);
    const written = writeCostRecord({ neo4j: { version: rig.server.version, edition: rig.edition }, commit: commitOf(), date: new Date().toISOString().slice(0, 10), dbHitCause: dbHitCauseFor(rig.server.version), pages });
    process.stdout.write(written === undefined ? `${pages.length} page costs read; no record written: NBX_SUPERNODE_RECORD is not set\n` : `${pages.length} page costs written to ${written}\n`);
  }, 3_600_000);
});

describe('the byte bound', () => {
  it('is the page times four thousand bytes', () => {
    expect(PAGE_BYTES).toBe(100_000);
  });
});
