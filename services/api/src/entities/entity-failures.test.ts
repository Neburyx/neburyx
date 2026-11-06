import { rmSync } from 'node:fs';
import { nodeSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import type { AuditEvent } from '../seams/seams.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityCalls, entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf, type Json } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import type { ExecuteOutcome } from '../gate/executor.js';
import type { SourceUsability } from '../source-test/usability.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

function mappingWith(overrides: Json = {}) {
  return parseMapping(
    fileOf(
      baseSource({
        id: 'demo',
        entities: [
          { type: 'widget', label: 'Widget', stable_id: 'widgetId', filterable: ['note'] },
          { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
          { type: 'gizmo', label: 'Gadget', stable_id: 'gadgetId' },
        ],
        relationships: [{ type: 'LINKS', from: 'widget', to: 'gadget' }],
        ...overrides,
      }),
    ),
    'neburyx.yaml',
  );
}

interface Options {
  readonly answer?: ExecuteOutcome;
  readonly usability?: SourceUsability;
  readonly mapping?: ReturnType<typeof mappingWith>;
}

async function started(options: Options = {}) {
  const mapping = options.mapping ?? mappingWith();
  const executor = new TestExecutor(() => Promise.resolve(options.answer ?? entityRows()));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const parts = testSourceGate(mapping, {
    executor,
    ...(options.usability === undefined ? {} : { usability: options.usability }),
    seams: {
      policy: defaults.policy,
      coordinator: defaults.coordinator,
      audit: {
        record: (event) => {
          events.push(event);
          return Promise.resolve();
        },
      },
    },
  });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate });
  return { app, executor, events };
}

describe('a read that cannot be answered', () => {
  it.each([
    ['a source that is down', { status: 'unavailable', reason: 'unreachable' } as const, 503, 'SOURCE_UNAVAILABLE'],
    ['a read that outlasts the source timeout', { status: 'timeout' } as const, 504, 'QUERY_TIMEOUT'],
  ])('answers %s with the retryable code of the error table, records the failure and keeps nothing', async (_name, answer, status, code) => {
    const { app, events } = await started({ answer });
    const response = await app.inject({ method: 'GET', url: '/v1/entities/demo/widget/W-1' });
    expect(response.statusCode).toBe(status);
    expect(response.json().error).toMatchObject({ code, retryable: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'entity.load', result: 'failed' });
    await app.close();
  });

  it('answers SOURCE_UNAVAILABLE without calling the adapter for a source whose mapping checks have not passed', async () => {
    const { app, executor, events } = await started({ usability: { isUsable: () => false }, answer: entityRows(plainNode(['Widget'], { widgetId: 'W-1' })) });
    const response = await app.inject({ method: 'GET', url: '/v1/entities/demo/widget/W-1' });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('SOURCE_UNAVAILABLE');
    expect(entityCalls(executor.calls)).toEqual([]);
    expect(events[0]).toMatchObject({ action: 'entity.load', result: 'refused' });
    await app.close();
  });
});

describe('a stable ID that looks like query text', () => {
  const ODD = ["x' OR 1=1 //", 'a`b', 'a\\b', 'MATCH (n) DETACH DELETE n', '}) RETURN 1 //', 'a/b', 'a?b#c', '100%', 'with space', 'ünï-€'];

  it('is found by literal equality when an entity has exactly that ID, after a round trip through percent-encoding', async () => {
    for (const id of ODD) {
      const { app, executor } = await started({ answer: entityRows(plainNode(['Widget'], { widgetId: id })) });
      const response = await app.inject({ method: 'GET', url: `/v1/entities/demo/widget/${encodeURIComponent(id)}` });
      expect(response.statusCode, id).toBe(200);
      expect(nodeSchema.parse(response.json()).ref.stableId).toBe(id);
      expect(entityCalls(executor.calls)[0]?.parameters['stableId']).toBe(id);
      await app.close();
    }
  });

  it('is sent as a parameter and never changes the statement, and finds nothing when no entity has it', async () => {
    const statements = new Set<string>();
    for (const id of [...ODD, 'plain']) {
      const { app, executor } = await started();
      const response = await app.inject({ method: 'GET', url: `/v1/entities/demo/widget/${encodeURIComponent(id)}` });
      expect(response.statusCode, id).toBe(404);
      statements.add(entityCalls(executor.calls)[0]?.cypher ?? '');
      await app.close();
    }
    expect(statements.size).toBe(1);
  });
});

describe('a stable ID that more than one node carries', () => {
  const first = plainNode(['Widget'], { widgetId: 'W-1', note: 'first' }, '4:fixture:1');
  const second = plainNode(['Widget'], { widgetId: 'W-1', note: 'second' }, '4:fixture:2');
  const third = plainNode(['Widget'], { widgetId: 'W-1', note: 'third' }, '4:fixture:3');
  const flagsOf = async (answer: ExecuteOutcome, mapping = mappingWith()) => {
    const { app } = await started({ answer, mapping });
    const response = await app.inject({ method: 'GET', url: '/v1/entities/demo/widget/W-1' });
    await app.close();
    expect(response.statusCode).toBe(200);
    return nodeSchema.parse(response.json());
  };

  it('has no flag when exactly one node has it', async () => {
    expect((await flagsOf(entityRows(first))).qualityFlags).not.toContain('duplicate-stable-id');
  });

  it.each([
    ['two identical nodes', entityRows(first, first)],
    ['two nodes that differ in a property', entityRows(first, second)],
    ['three nodes, the third differing', entityRows(first, first, third)],
  ])('flags %s with duplicate-stable-id, shows the first, and does not claim a conflict', async (_name, answer) => {
    const node = await flagsOf(answer);
    expect(node.qualityFlags).toContain('duplicate-stable-id');
    expect(node.qualityFlags).not.toContain('conflicting-duplicate');
    expect(node.properties.find((property) => property.key === 'note')?.value).toBe('first');
  });

  it('asks the server for the nodes in a fixed order so the same node is shown every time', async () => {
    const { app, executor } = await started({ answer: entityRows(first, second) });
    await app.inject({ method: 'GET', url: '/v1/entities/demo/widget/W-1' });
    expect(entityCalls(executor.calls)[0]?.cypher).toContain('ORDER BY elementId(n)');
    await app.close();
  });

  it('is flagged also when the source allows one row per page', async () => {
    const node = await flagsOf(entityRows(first, second), mappingWith({ budgets: { max_page: 1 } }));
    expect(node.qualityFlags).toContain('duplicate-stable-id');
  });
});

describe('a label that two entity types share', () => {
  it('answers NOT_FOUND for either type, because the normalizer cannot say which type the node is', async () => {
    const { app } = await started({ answer: entityRows(plainNode(['Gadget'], { gadgetId: 'H-1' })) });
    expect((await app.inject({ method: 'GET', url: '/v1/entities/demo/gadget/H-1' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/entities/demo/gizmo/H-1' })).statusCode).toBe(404);
    await app.close();
  });
});
