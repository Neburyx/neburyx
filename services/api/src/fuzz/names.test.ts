import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { closedSetOf, statementProblems } from '../testing/fuzz-closed-set.js';
import { FIELD_NAMES, TEMPLATE_NATIVE, fuzzParams, hostileText, textLeaves } from '../testing/fuzz-corpus.js';
import { FUZZ_SOURCE, FUZZ_TEXT, allowedNames, startFuzzRig } from '../testing/fuzz-rig.js';

const names = new Set([...allowedNames(), 'widget', 'gadget', 'phone', FUZZ_SOURCE]);
const known = new Set([...names, ...FIELD_NAMES, ...TEMPLATE_NATIVE]);
const rig = await startFuzzRig();
const closed = await closedSetOf(rig);

const codeOf = (body: string): string | undefined => {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
};

/** Entity types the mapping does not name: unmapped, other case, padded, a label, hostile text. */
const unmappedType = fc.oneof(hostileText(names).filter((text) => text !== ''), fc.constantFrom('Widget', 'WIDGET', ' widget', 'widget ', 'Gadget', 'node_a', 'sprocket', 'gizmo', 'widgetId'));

describe('an entity type the mapping does not name', () => {
  const routes: readonly { name: string; code: string; send: (entityType: string) => Promise<{ body: string }> }[] = [
    { name: 'derived neighbors', code: 'NOT_FOUND', send: (entityType) => rig.post('/v1/graph/derived-neighbors', { sourceId: FUZZ_SOURCE, ref: { entityType, stableId: 'W-1' } }) },
    { name: 'degree preview', code: 'NOT_FOUND', send: (entityType) => rig.post('/v1/graph/preview-expansion', { sourceId: FUZZ_SOURCE, ref: { entityType, stableId: 'W-1' } }) },
    { name: 'coverage', code: 'NOT_FOUND', send: (entityType) => rig.post('/v1/graph/coverage', { sourceId: FUZZ_SOURCE, entities: [{ ref: { sourceId: FUZZ_SOURCE, entityType, stableId: 'W-1' }, loadedRelationships: 1, loadedQuality: 'exact' }] }) },
    { name: 'expand (ref)', code: 'INVALID_REQUEST', send: (entityType) => rig.post('/v1/graph/expand', { sourceId: FUZZ_SOURCE, ref: { entityType, stableId: 'W-1' }, neighborTypes: ['gadget'] }) },
    { name: 'expand (neighbor type)', code: 'INVALID_REQUEST', send: (entityType) => rig.post('/v1/graph/expand', { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes: [entityType] }) },
    { name: 'search entityTypes', code: 'INVALID_REQUEST', send: (entityType) => rig.post('/v1/search/entities', { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, entityTypes: [entityType] }) },
    { name: 'search more entityTypes', code: 'INVALID_REQUEST', send: (entityType) => rig.post('/v1/search/entities/more', { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, group: 'exact', cursor: 'v1.x.y', entityTypes: [entityType] }) },
    { name: 'lookup by reference', code: 'INVALID_REQUEST', send: (entityType) => rig.post('/v1/entities/lookup', { sourceId: FUZZ_SOURCE, ref: { entityType, stableId: 'W-1' } }) },
    { name: 'lookup by value', code: 'INVALID_REQUEST', send: (entityType) => rig.post('/v1/entities/lookup', { sourceId: FUZZ_SOURCE, value: { entityType, value: 'W-1' } }) },
    { name: 'entity GET', code: 'INVALID_REQUEST', send: async (entityType) => ({ body: (await rig.app.inject({ method: 'GET', url: `/v1/entities/${FUZZ_SOURCE}/${encodeURIComponent(entityType)}/W-1` })).body }) },
  ];

  for (const route of routes) {
    it(`${route.name}: ${route.code}, and nothing is read`, async () => {
      await fc.assert(
        fc.asyncProperty(unmappedType, async (entityType) => {
          rig.reset();
          const response = await route.send(entityType);
          expect(codeOf(response.body)).toBe(route.code);
          expect(rig.executor.calls).toEqual([]);
          expect(statementProblems(rig, closed, [entityType].filter((text) => !known.has(text) && text.length >= 4))).toEqual([]);
        }),
        fuzzParams(60),
      );
    });
  }
});

describe('coverage', () => {
  const entity = (index: number, sourceId = FUZZ_SOURCE) => ({ ref: { sourceId, entityType: 'widget', stableId: `W-${index}` }, loadedRelationships: 1, loadedQuality: 'exact' });

  it('refuses 0 or 501 entries and a duplicate with INVALID_REQUEST, a ref of another source with SOURCE_MISMATCH, and never reads', async () => {
    const cases: readonly [string, unknown, string][] = [
      ['no entries', { sourceId: FUZZ_SOURCE, entities: [] }, 'INVALID_REQUEST'],
      ['501 entries', { sourceId: FUZZ_SOURCE, entities: Array.from({ length: 501 }, (_, index) => entity(index)) }, 'INVALID_REQUEST'],
      ['a duplicate entity', { sourceId: FUZZ_SOURCE, entities: [entity(1), entity(1)] }, 'INVALID_REQUEST'],
      ['a ref of another source', { sourceId: FUZZ_SOURCE, entities: [entity(1, 'other')] }, 'SOURCE_MISMATCH'],
    ];
    for (const [name, body, code] of cases) {
      rig.reset();
      expect(codeOf((await rig.post('/v1/graph/coverage', body)).body), name).toBe(code);
      expect(rig.executor.calls, name).toEqual([]);
    }
  });

  it('leaves the executor empty for every body, accepted or not', async () => {
    const body = fc.record({
      sourceId: fc.oneof(fc.constant(FUZZ_SOURCE), hostileText(names)),
      entities: fc.array(
        fc.record({ ref: fc.record({ sourceId: fc.oneof(fc.constant(FUZZ_SOURCE), hostileText(names)), entityType: fc.oneof(fc.constantFrom('widget', 'gadget', 'phone'), unmappedType), stableId: fc.oneof(fc.constant('W-1'), hostileText(names)) }), loadedRelationships: fc.integer({ min: -2, max: 1000 }), loadedQuality: fc.constantFrom('exact', 'estimated', 'unknown', 'other') }),
        { maxLength: 6 },
      ),
      mask: fc.option(fc.boolean(), { nil: undefined }),
    });
    await fc.assert(
      fc.asyncProperty(body, async (request) => {
        rig.reset();
        await rig.post('/v1/graph/coverage', request);
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(150),
    );
  });
});

describe('exactRefs of search more', () => {
  const more = { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, group: 'related', cursor: 'v1.x.y' };
  const ref = (extra: Record<string, unknown> = {}) => ({ sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-1', ...extra });

  it('refuses a ref of another source, of an unmapped type, or sent to a group other than related, with INVALID_REQUEST before any read', async () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ['another source', { ...more, exactRefs: [ref({ sourceId: 'other' })] }],
      ['an unmapped type', { ...more, exactRefs: [ref({ entityType: 'sprocket' })] }],
      ['the exact group', { ...more, group: 'exact', exactRefs: [ref()] }],
      ['the evidence group', { ...more, group: 'evidence', exactRefs: [ref()] }],
    ];
    for (const [name, body] of cases) {
      rig.reset();
      expect(codeOf((await rig.post('/v1/search/entities/more', body)).body), name).toBe('INVALID_REQUEST');
      expect(rig.executor.calls, name).toEqual([]);
    }
    await fc.assert(
      fc.asyncProperty(unmappedType, async (entityType) => {
        rig.reset();
        expect(codeOf((await rig.post('/v1/search/entities/more', { ...more, exactRefs: [ref({ entityType })] })).body)).toBe('INVALID_REQUEST');
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(60),
    );
  });
});

describe('the request as a whole', () => {
  const body = { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT };

  it('answers malformed JSON and a body over 1 MiB with INVALID_REQUEST, and a content type that is not JSON with UNSUPPORTED_MEDIA_TYPE (plain text with INVALID_REQUEST), with no stack text and no echo of the input', async () => {
    const marker = 'ZZ-MARKER-QQ';
    const inject = (payload: string, type = 'application/json') => rig.app.inject({ method: 'POST', url: '/v1/search/entities', payload, headers: { 'content-type': type } });
    const cases: readonly [string, Awaited<ReturnType<typeof inject>>, string][] = [
      ['malformed JSON', await inject(`{"sourceId": "demo", "text": "${marker}"`), 'INVALID_REQUEST'],
      ['a body that is not an object', await inject(JSON.stringify([marker])), 'INVALID_REQUEST'],
      ['a body over 1 MiB', await inject(JSON.stringify({ ...body, text: marker.repeat(100_000) })), 'INVALID_REQUEST'],
      ['plain text, which is parsed as a string and is not an object', await inject(JSON.stringify({ ...body, text: marker }), 'text/plain'), 'INVALID_REQUEST'],
      ['application/xml', await inject(JSON.stringify({ ...body, text: marker }), 'application/xml'), 'UNSUPPORTED_MEDIA_TYPE'],
      ['a form', await inject(JSON.stringify({ ...body, text: marker }), 'application/x-www-form-urlencoded'), 'UNSUPPORTED_MEDIA_TYPE'],
      ['multipart', await inject(JSON.stringify({ ...body, text: marker }), 'multipart/form-data'), 'UNSUPPORTED_MEDIA_TYPE'],
      ['no content type', await rig.app.inject({ method: 'POST', url: '/v1/search/entities', payload: JSON.stringify({ ...body, text: marker }) }), 'UNSUPPORTED_MEDIA_TYPE'],
    ];
    for (const [name, response, code] of cases) {
      expect(codeOf(response.body), name).toBe(code);
      expect(response.body, name).not.toContain(marker);
      expect(response.body, name).not.toMatch(/\bat \w+.*\(.*:\d+:\d+\)|node_modules|Error:/);
    }
    expect(rig.executor.calls).toEqual([]);
  });
});
