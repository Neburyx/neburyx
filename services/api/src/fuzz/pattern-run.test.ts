import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { statementProblems } from '../testing/fuzz-closed-set.js';
import type { FuzzRig } from '../testing/fuzz-rig.js';
import { TestExecutor } from '../testing/gate.js';
import { noMatchRow } from '../testing/pattern-fixtures.js';
import { learnedGrammar } from '../testing/pattern-grammar-fixture.js';
import { RECORDED_RUNS, SEED_OF_RECORD, definitionOf, enumerateShapes, randomShapes, shapeAllowlist, shapeMappingOf, type Shape } from '../testing/pattern-shapes.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

// every shape goes through the route and the gate, which is slow when the suites run together
vi.setConfig({ testTimeout: 180_000 });

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const SENTINEL_TEXT = 'zz-sentinel-condition-4711';
const SENTINEL_ANCHOR = 'zz-sentinel-anchor-5151';
const NAMES = new Set(['Maker', 'Tool', 'makerId', 'toolId', 'region', 'rank', 'kind', 'lane', 'seenAt', 'spottedAt', 'linkId', 'trustId', 'serveId', 'pairId', 'useId', 'madeId', 'fixId', 'isCommon', 'isHub', 'isBusy', 'isBroken', 'LINKS', 'ALLIES', 'TRUSTS', 'KNOWS', 'SERVES', 'PAIRS', 'USES_TOOL', 'MADE_BY', 'FIXES']);

/** The real app and gate, over the fixture's mapping with the given stop-list rules and a recording executor that answers every read with no rows. */
async function started(stopRules: 0 | 1 | 2) {
  const full = shapeMappingOf(stopRules);
  const [only] = full.sources;
  if (only === undefined) throw new Error('no source');
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(only)), (): Promise<ExecuteOutcome> => Promise.resolve({ status: 'rows', rows: [noMatchRow(SENTINEL_ANCHOR)] })));
  const defaults = communitySeams();
  const parts = testSourceGate(full, { executor, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit } });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping: full, gate: parts.gate, seams: defaults, catalog: parts.catalog, limiter: { admit: () => undefined, inspect: () => new Map(), close: () => undefined } });
  return { app, executor };
}

describe('the run route over the shapes of the enumerator', () => {
  it('sends each shape once and every statement the executor sees is accepted by the grammar, holds no value of the request and quotes only mapped names', async () => {
    const grammar = learnedGrammar();
    const apps = { 0: await started(0), 1: await started(1), 2: await started(2) } as const;
    let sent = 0;
    const run = async (shape: Shape): Promise<void> => {
      const { app, executor } = apps[shape.stopRules];
      sent += 1;
      const response = await app.inject({
        method: 'POST',
        url: '/v1/patterns/run',
        payload: { sourceId: 'demo', definition: definitionOf(shape, SENTINEL_TEXT) as object, anchor: { entityType: 'maker', stableId: SENTINEL_ANCHOR } },
        headers: { 'idempotency-key': `key-${String(sent).padStart(8, '0')}-of-sixteen`, 'content-type': 'application/json' },
      });
      expect(response.statusCode, `${JSON.stringify(shape)} ${response.body.slice(0, 200)}`).toBe(200);
      const reads = executor.calls.splice(0);
      expect(reads.some((call) => call.templateId === 'pattern'), JSON.stringify(shape)).toBe(true);
      const rig = { executor: { calls: reads.filter((call) => call.templateId === 'pattern') } } as unknown as FuzzRig;
      expect(statementProblems(rig, new Set(), [SENTINEL_TEXT, SENTINEL_ANCHOR], { grammar, allowlist: shapeAllowlist(shape.stopRules), names: NAMES }), JSON.stringify(shape)).toEqual([]);
    };
    for (const shape of enumerateShapes()) await run(shape);
    for (const shape of randomShapes(SEED_OF_RECORD, RECORDED_RUNS)) await run(shape);
    expect(sent).toBeGreaterThan(1000);
  });
});
