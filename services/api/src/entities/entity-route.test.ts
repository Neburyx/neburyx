import { rmSync } from 'node:fs';
import { nodeSchema, pathSegmentOf } from '@neburyx/contracts';
import neo4j from 'neo4j-driver';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { prepareParameters } from '../sources/parameters.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityCalls, entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      entities: [
        { type: 'widget', label: 'Widget', stable_id: 'widgetId', title: 'Widget {widgetId}', display: { key_properties: ['status'] }, pii: [{ property: 'ownerName', class: 'name' }] },
        { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', title: '{gadgetName}', pii: [{ property: 'gadgetName', class: 'name' }] },
      ],
      relationships: [{ type: 'HOLDS', from: 'gadget', to: 'widget' }],
    }),
  ),
  'neburyx.yaml',
);

const ACCOUNT = plainNode(['Widget'], { widgetId: 'AC-1', status: 'open', ownerName: 'Ana Silva' });

function recordingSeams(): { readonly seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'>; readonly events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  return { events, seams: {
      policy: defaults.policy,
      coordinator: defaults.coordinator,
      audit: {
        record: (event) => {
          events.push(event);
          return Promise.resolve();
        },
      },
    },
  };
}

async function started(answer = entityRows(ACCOUNT)) {
  const executor = new TestExecutor(withOnlineIndexes(mapping.sources[0] ?? (() => { throw new Error('the mapping has no source'); })(), () => Promise.resolve(answer)));
  const recorded = recordingSeams();
  const parts = testSourceGate(mapping, { executor, seams: recorded.seams });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate });
  return { app, executor, events: recorded.events };
}

const get = (app: Awaited<ReturnType<typeof started>>['app'], url: string) => app.inject({ method: 'GET', url });

describe('GET /v1/entities/{sourceId}/{entityType}/{stableId}', () => {
  it('answers 200 with the node the normalize stage builds, reads it as a user template and writes one audit event', async () => {
    const { app, executor, events } = await started();
    const response = await get(app, '/v1/entities/demo/widget/AC-1');
    expect(response.statusCode).toBe(200);
    const node = nodeSchema.parse(response.json());
    expect(node.ref).toEqual({ sourceId: 'demo', entityType: 'widget', stableId: 'AC-1' });
    expect(node.display).toEqual({ title: 'Widget AC-1', type: 'widget' });
    expect(node.properties.map((property) => property.key)).toEqual(expect.arrayContaining(['widgetId', 'status', 'ownerName']));
    expect(node.qualityFlags).toEqual([]);
    const [call] = entityCalls(executor.calls);
    expect(call).toMatchObject({ templateId: 'entity-load', accessMode: 'READ', rowLimit: 2 });
    expect(events.filter((event) => event.action === 'entity.load')).toEqual([{ actorId: expect.any(String), actorRole: 'administrator', action: 'entity.load', result: 'success', sourceId: 'demo', traceId: expect.any(String) }]);
    await app.close();
  });

  it('writes the type label and the stable ID property only from the mapping, and sends the ID as a parameter', async () => {
    const { app, executor } = await started();
    await get(app, '/v1/entities/demo/widget/AC-1');
    const [call] = entityCalls(executor.calls);
    expect(call?.cypher).toBe('MATCH (n:`Widget`) WHERE n.`widgetId` IN [$stableId, $stableInteger] RETURN n ORDER BY elementId(n) LIMIT $limit + 1');
    expect(call?.parameters).toMatchObject({ stableId: 'AC-1', stableInteger: null, limit: 1 });
    await app.close();
  });

  it('masks each personal-data value the node has when asked, and a title built from one, with maskedBy request', async () => {
    const gadget = plainNode(['Gadget'], { gadgetId: 'C-9', gadgetName: 'Ana Silva' });
    const { app } = await started(entityRows(gadget));
    const masked = nodeSchema.parse((await get(app, '/v1/entities/demo/gadget/C-9?mask=true')).json());
    const name = masked.properties.find((property) => property.key === 'gadgetName');
    expect(name).toMatchObject({ masked: true, maskedBy: 'request' });
    expect(JSON.stringify(masked)).not.toContain('Ana Silva');
    expect(masked.display.title).not.toContain('Ana');
    const plain = nodeSchema.parse((await get(app, '/v1/entities/demo/gadget/C-9')).json());
    expect(plain.display.title).toBe('Ana Silva');
    expect(plain.properties.find((property) => property.key === 'gadgetName')).toMatchObject({ value: 'Ana Silva', masked: false });
    await app.close();
  });

  it('leaves a personal-data property the record lacks absent when masking', async () => {
    const widget = plainNode(['Widget'], { widgetId: 'AC-2', status: 'open' });
    const { app } = await started(entityRows(widget));
    const node = nodeSchema.parse((await get(app, '/v1/entities/demo/widget/AC-2?mask=true')).json());
    expect(node.properties.find((property) => property.key === 'ownerName')).toBeUndefined();
    await app.close();
  });

  it('answers NOT_FOUND for an ID the source does not hold, with the same body whatever the ID', async () => {
    const { app } = await started(entityRows());
    const first = await get(app, '/v1/entities/demo/widget/AC-404');
    const second = await get(app, '/v1/entities/demo/widget/other');
    expect(first.statusCode).toBe(404);
    expect(first.json().error.code).toBe('NOT_FOUND');
    expect({ ...second.json().error, traceId: undefined }).toEqual({ ...first.json().error, traceId: undefined });
    await app.close();
  });

  it('answers NOT_FOUND for a source that is not configured, without reading anything', async () => {
    const { app, executor } = await started();
    const response = await get(app, '/v1/entities/nope/widget/AC-1');
    expect(response.statusCode).toBe(404);
    expect(entityCalls(executor.calls)).toEqual([]);
    await app.close();
  });

  it.each([
    ['an entity type the mapping does not name', '/v1/entities/demo/sprocket/S-1'],
    ['a query parameter other than mask', '/v1/entities/demo/widget/AC-1?limit=5'],
    ['a mask value that is not true or false', '/v1/entities/demo/widget/AC-1?mask=yes'],
    ['a second mask parameter', '/v1/entities/demo/widget/AC-1?mask=true&mask=false'],
    ['a stable ID of 401 characters', `/v1/entities/demo/widget/${'a'.repeat(401)}`],
    ['a stable ID of 2,401 characters, past the old limit of the router', `/v1/entities/demo/widget/${'a'.repeat(2401)}`],
    ['a stable ID of 12,000 characters', `/v1/entities/demo/widget/${'a'.repeat(12_000)}`],
    ['an entity type of 5,000 characters', `/v1/entities/demo/${'t'.repeat(5000)}/AC-1`],
  ])('answers INVALID_REQUEST for %s, without reading', async (_name, url) => {
    const { app, executor } = await started();
    const response = await get(app, url);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(entityCalls(executor.calls)).toEqual([]);
    await app.close();
  });

  it('takes a stable ID of exactly 400 characters, counted as characters and not bytes', async () => {
    const { app, executor } = await started(entityRows());
    const id = '€'.repeat(400);
    expect((await get(app, `/v1/entities/demo/widget/${encodeURIComponent(id)}`)).statusCode).toBe(404);
    expect(entityCalls(executor.calls)[0]?.parameters['stableId']).toBe(id);
    expect((await get(app, `/v1/entities/demo/widget/${encodeURIComponent(`${id}€`)}`)).statusCode).toBe(400);
    await app.close();
  });

  it('answers INTERNAL_ERROR, not NOT_FOUND, when the read returns a row that is not a node of the entity type asked for', async () => {
    const { app } = await started(entityRows(plainNode(['Gadget'], { gadgetId: 'AC-1', gadgetName: 'Ana Silva' })));
    expect((await get(app, '/v1/entities/demo/widget/AC-1')).statusCode).toBe(500);
    await app.close();
  });
});

describe('a stable ID or entity type made only of dots', () => {
  it.each(['.', '..', '...', '~', '~.'])('is found when the segment carries it with a tilde in front, and is sent to the source as %j', async (id) => {
    const { app, executor } = await started(entityRows(plainNode(['Widget'], { widgetId: id })));
    const response = await get(app, `/v1/entities/demo/widget/${encodeURIComponent(pathSegmentOf(id))}`);
    expect(response.statusCode).toBe(200);
    expect(nodeSchema.parse(response.json()).ref.stableId).toBe(id);
    expect(entityCalls(executor.calls)[0]?.parameters['stableId']).toBe(id);
    await app.close();
  });

  it('reaches the route through a real fetch only with the tilde: without it the URL parser removes the segment', async () => {
    const { app, executor } = await started(entityRows(plainNode(['Widget'], { widgetId: '..' })));
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      expect((await fetch(`${address}/v1/entities/demo/widget/..`)).status).toBe(404);
      expect(entityCalls(executor.calls)).toEqual([]);
      const reply = await fetch(`${address}/v1/entities/demo/widget/${encodeURIComponent(pathSegmentOf('..'))}`);
      expect(reply.status).toBe(200);
      expect(nodeSchema.parse(await reply.json()).ref).toEqual({ sourceId: 'demo', entityType: 'widget', stableId: '..' });
      expect(entityCalls(executor.calls)[0]?.parameters['stableId']).toBe('..');
    } finally {
      await app.close();
    }
  });

  it('takes an entity type of dots only the same way, and refuses a lone tilde as an empty ID', async () => {
    const { app, executor } = await started();
    expect((await get(app, '/v1/entities/demo/~../AC-1')).statusCode).toBe(400);
    expect((await get(app, '/v1/entities/demo/widget/~')).statusCode).toBe(400);
    expect(entityCalls(executor.calls)).toEqual([]);
    await app.close();
  });
});

describe('the stable ID as an integer', () => {
  async function candidate(id: string): Promise<unknown> {
    const { app, executor } = await started(entityRows());
    await get(app, `/v1/entities/demo/widget/${encodeURIComponent(id)}`);
    await app.close();
    return entityCalls(executor.calls)[0]?.parameters['stableInteger'];
  }

  it.each([
    ['123', '123'],
    ['0', '0'],
    ['-42', '-42'],
    ['9007199254740993', '9007199254740993'],
    ['9223372036854775807', '9223372036854775807'],
    ['-9223372036854775808', '-9223372036854775808'],
  ])('also matches %s as the integer it spells, exactly', async (id, value) => {
    expect(await candidate(id)).toEqual({ $type: 'integer', value });
  });

  it.each(['0123', '+5', '1.0', '-0', '1e3', ' 12', '12 ', '9223372036854775808', '-9223372036854775809', '１２３', '0x10', 'x'])('matches %j as text only', async (id) => {
    expect(await candidate(id)).toBeNull();
  });

  it('turns a tagged integer into a driver integer of its exact value and leaves every other parameter as it was', () => {
    const prepared = prepareParameters({ stableId: '9007199254740993', stableInteger: { $type: 'integer', value: '9007199254740993' }, other: { $type: 'integer', value: 'x', extra: 1 }, absent: null }, []);
    expect(neo4j.isInt(prepared['stableInteger'])).toBe(true);
    expect(String(prepared['stableInteger'])).toBe('9007199254740993');
    expect(prepared['stableId']).toBe('9007199254740993');
    expect(prepared['other']).toEqual({ $type: 'integer', value: 'x', extra: 1 });
    expect(prepared['absent']).toBeNull();
  });
});
