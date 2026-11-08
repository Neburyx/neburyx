import { rmSync } from 'node:fs';
import { degreePreviewSchema, type DegreePreview } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const CAP = 500;
const widgetDegree = [
  { type: 'LINKS', direction: 'out', property: 'linksOut', observed_at: 'linksOutAt' },
  { type: 'KNOWS', direction: 'in', property: 'knowsIn' },
];
const entities = (degree: unknown = widgetDegree) => [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', degree },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
];
const relationships = [
  { type: 'LINKS', from: 'widget', to: 'gadget' },
  { type: 'KNOWS', from: 'gadget', to: 'widget' },
];

const emptyShape: DegreePreview = { ref: { sourceId: 'alpha', entityType: 'widget', stableId: 'W-1' }, total: { quality: 'unknown', scope: 'x' }, byType: [], byNeighborType: [], warnings: [], pageSize: 1, heavyOpThreshold: CAP };

interface Captured {
  readonly logs: string[];
  readonly events: AuditEvent[];
}

/** The widget row is c0 (LINKS out), c1 (KNOWS in), then p0, t0 (the declared property and date of LINKS out) and p1. */
async function previewOf(row: Record<string, unknown>, degree: unknown = widgetDegree, rows: readonly Record<string, unknown>[] = relationships, deny = false): Promise<{ readonly preview: DegreePreview; readonly captured: Captured }> {
  const mapping = parseMapping(fileOf(baseSource({ id: 'alpha', entities: entities(degree), relationships: rows })), 'neburyx.yaml');
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const captured: Captured = { logs: [], events: [] };
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = { policy: deny ? { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } : defaults.policy, coordinator: defaults.coordinator, audit: { record: (event) => (captured.events.push(event), Promise.resolve()) } };
  const executor = new TestExecutor(withOnlineIndexes(source, (): Promise<ExecuteOutcome> => Promise.resolve({ status: 'rows', rows: [row] })));
  const parts = testSourceGate(mapping, { executor, seams });
  const app = await buildApp({ webRoot, logger: createLogger({ write: (line) => captured.logs.push(String(line)) }), store: memoryAppStore(), mapping, gate: parts.gate, seams });
  const response = await app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload: { sourceId: 'alpha', ref: { entityType: 'widget', stableId: 'W-1' } } });
  await app.close();
  expect(response.statusCode).toBe(deny ? 404 : 200);
  if (deny) {
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    return { preview: { ...emptyShape }, captured };
  }
  return { preview: degreePreviewSchema.parse(response.json()), captured };
}

const row = (extra: Record<string, unknown>) => ({ c0: CAP + 1, c1: 3, ...extra });
const ignoredOf = (preview: DegreePreview) => preview.warnings.filter((warning) => warning.code === 'degree-property-ignored');

describe('the preview of a node with an estimated count', () => {
  it('answers the estimate with its date, keeps the capped warning, and gives the neighbor type of one pair the same count', async () => {
    const { preview } = await previewOf(row({ p0: 10_000, t0: { $type: 'dateTime', value: '2026-01-02T03:04:05Z' }, p1: null }));
    expect(preview.byType[0]?.count).toEqual({ value: 10_000, quality: 'estimated', scope: 'degree:out:LINKS:mapped-relationship-ends', observedAt: '2026-01-02T03:04:05Z' });
    expect(preview.warnings.filter((warning) => warning.code === 'counts-capped')).toHaveLength(2);
    expect(ignoredOf(preview)).toEqual([]);
  });

  it('is estimated in the total with no date when another pair is exact, and in the neighbor type reached through both pairs', async () => {
    const { preview } = await previewOf(row({ p0: 10_000, t0: '2026-01-02', p1: null }));
    expect(preview.total).toEqual({ value: 10_003, quality: 'estimated', scope: 'degree:total:mapped-relationship-ends' });
    expect(preview.byNeighborType).toEqual([{ entityType: 'gadget', count: { value: 10_003, quality: 'estimated', scope: 'degree:neighbor:gadget:mapped-relationship-ends' } }]);
  });

  it('is a lower bound that adds what each part proved when another pair is only a lower bound: the estimate counts at the cap', async () => {
    const { preview } = await previewOf({ c0: CAP + 1, c1: CAP + 1, p0: 10_000, t0: null, p1: null });
    expect(preview.total).toEqual({ value: 2 * CAP, quality: 'lowerBound', scope: 'degree:total:mapped-relationship-ends' });
    expect(preview.byNeighborType[0]?.count).toEqual({ value: 2 * CAP, quality: 'lowerBound', scope: 'degree:neighbor:gadget:mapped-relationship-ends' });
    expect(preview.total.value).not.toBe(10_500);
  });

  it('keeps a single pair as it is read, date included, in a neighbor type that only it reaches', async () => {
    const { preview } = await previewOf({ c0: CAP + 1, p0: 10_000, t0: '2026-01-02' }, [{ type: 'LINKS', direction: 'out', property: 'linksOut', observed_at: 'linksOutAt' }], [{ type: 'LINKS', from: 'widget', to: 'gadget' }]);
    expect(preview.byType[0]?.count).toMatchObject({ value: 10_000, quality: 'estimated', observedAt: '2026-01-02' });
    expect(preview.total).toEqual({ value: 10_000, quality: 'estimated', scope: 'degree:total:mapped-relationship-ends', observedAt: '2026-01-02' });
    expect(preview.byNeighborType[0]?.count).toEqual({ value: 10_000, quality: 'estimated', scope: 'degree:neighbor:gadget:mapped-relationship-ends', observedAt: '2026-01-02' });
  });

  it('has a configuration hash that changes with a declaration, which is what a held preview is keyed by', async () => {
    const hashOf = (degree: unknown) => parseMapping(fileOf(baseSource({ id: 'alpha', entities: entities(degree), relationships })), 'neburyx.yaml').sources[0]?.configHash;
    const base = hashOf([]);
    expect(hashOf(widgetDegree)).not.toBe(base);
    expect(hashOf([{ type: 'LINKS', direction: 'out', property: 'other' }])).not.toBe(hashOf([{ type: 'LINKS', direction: 'out', property: 'linksOut' }]));
    expect(hashOf([{ type: 'LINKS', direction: 'out', property: 'a', observed_at: 'x' }])).not.toBe(hashOf([{ type: 'LINKS', direction: 'out', property: 'a' }]));
  });
});

describe('the preview of a node the person may not read', () => {
  it('answers NOT_FOUND and builds no estimate, though the property would give one', async () => {
    await previewOf(row({ p0: 10_000, t0: null, p1: null }), widgetDegree, relationships, true);
  });
});

describe('the preview of a node whose declared property cannot be used', () => {
  it.each([
    ['text', 'many'],
    ['a boolean', true],
    ['a list', [10_000]],
    ['a fraction', 1200.5],
    ['a negative number', -4],
    ['zero', 0],
    ['a number below the cap', 12],
    ['a number equal to the cap', CAP],
    ['an integer beyond the safe range', { $type: 'integer', value: '9223372036854775807' }],
  ])('leaves the lower bound and says one property was ignored when it holds %s', async (_name, stored) => {
    const { preview } = await previewOf(row({ p0: stored, t0: '2026-01-02', p1: null }));
    expect(preview.byType[0]?.count).toEqual({ value: CAP, quality: 'lowerBound', scope: 'degree:out:LINKS:mapped-relationship-ends' });
    expect(ignoredOf(preview)).toEqual([{ code: 'degree-property-ignored', relationshipType: 'LINKS', reason: expect.any(String) as string }]);
  });

  it('says nothing about a property the node does not have', async () => {
    const { preview } = await previewOf(row({ p0: null, t0: null, p1: null }));
    expect(preview.byType[0]?.count).toMatchObject({ value: CAP, quality: 'lowerBound' });
    expect(ignoredOf(preview)).toEqual([]);
  });

  it('says it once for a relationship type declared in both directions', async () => {
    const selfLink = [{ type: 'LINKS', from: 'widget', to: 'widget' }];
    const { preview } = await previewOf({ c0: CAP + 1, c1: CAP + 1, p0: 'x', p1: 'y' }, [{ type: 'LINKS', direction: 'out', property: 'a' }, { type: 'LINKS', direction: 'in', property: 'b' }], selfLink);
    expect(preview.byType.map((entry) => entry.direction)).toEqual(['out', 'in']);
    expect(ignoredOf(preview).map((warning) => warning.relationshipType)).toEqual(['LINKS']);
  });

  it('puts neither the stored value nor the property key in the answer, a log line or an audit event', async () => {
    const { preview, captured } = await previewOf(row({ p0: 'SENTINEL-VALUE-77', t0: null, p1: null }));
    const everything = JSON.stringify([preview, captured.logs, captured.events]);
    expect(everything).not.toContain('SENTINEL-VALUE-77');
    expect(everything).not.toContain('linksOut');
    expect(everything).not.toContain('knowsIn');
  });

  it('puts neither value nor key anywhere when the estimate is taken', async () => {
    const { preview, captured } = await previewOf(row({ p0: 7_777_777, t0: null, p1: null }));
    expect(JSON.stringify([captured.logs, captured.events])).not.toContain('7777777');
    expect(JSON.stringify([captured.logs, captured.events])).not.toContain('linksOut');
    expect(preview.byType[0]?.count.value).toBe(7_777_777);
  });
});
