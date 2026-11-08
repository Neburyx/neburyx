import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { closedSetOf, statementProblems } from '../testing/fuzz-closed-set.js';
import { CYPHER_FRAGMENTS, FIELD_NAMES, TEMPLATE_NATIVE, fuzzParams, hostileText, textLeaves, wrongType } from '../testing/fuzz-corpus.js';
import { FUZZ_SOURCE, FUZZ_TEXT, allowedNames, startFuzzRig } from '../testing/fuzz-rig.js';

const names = new Set([...allowedNames(), 'widget', 'gadget', 'phone', 'MADE_FROM', 'USES', FUZZ_SOURCE, 'exact', 'related', 'evidence', 'out', 'in', 'both']);
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

interface Route {
  readonly name: string;
  readonly url: string;
  readonly body: Record<string, unknown>;
  /** Paths of the fields the schema requires, as keys from the body down. */
  readonly required: readonly (readonly string[])[];
  /** Paths of text fields, with the length one over the cap. */
  readonly capped: readonly { readonly path: readonly string[]; readonly over: number }[];
}

const REF = { entityType: 'widget', stableId: 'W-1' };
const ROUTES: readonly Route[] = [
  { name: 'search', url: '/v1/search/entities', body: { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT }, required: [['sourceId'], ['text']], capped: [{ path: ['text'], over: 201 }] },
  { name: 'type-ahead search', url: '/v1/search/entities', body: { sourceId: FUZZ_SOURCE, text: 'ne', typeahead: true }, required: [['sourceId'], ['text']], capped: [{ path: ['text'], over: 201 }] },
  { name: 'search more', url: '/v1/search/entities/more', body: { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, group: 'exact', cursor: 'v1.x.y' }, required: [['sourceId'], ['text'], ['group'], ['cursor']], capped: [{ path: ['text'], over: 201 }] },
  { name: 'lookup by reference', url: '/v1/entities/lookup', body: { sourceId: FUZZ_SOURCE, ref: REF }, required: [['sourceId'], ['ref'], ['ref', 'entityType'], ['ref', 'stableId']], capped: [{ path: ['ref', 'stableId'], over: 266_692 }] },
  { name: 'lookup by value', url: '/v1/entities/lookup', body: { sourceId: FUZZ_SOURCE, value: { entityType: 'widget', value: 'W-1' } }, required: [['sourceId'], ['value'], ['value', 'entityType'], ['value', 'value']], capped: [{ path: ['value', 'value'], over: 100_001 }] },
  { name: 'degree preview', url: '/v1/graph/preview-expansion', body: { sourceId: FUZZ_SOURCE, ref: REF }, required: [['sourceId'], ['ref'], ['ref', 'entityType'], ['ref', 'stableId']], capped: [{ path: ['ref', 'stableId'], over: 266_692 }] },
  { name: 'coverage', url: '/v1/graph/coverage', body: { sourceId: FUZZ_SOURCE, entities: [{ ref: { sourceId: FUZZ_SOURCE, ...REF }, loadedRelationships: 1, loadedQuality: 'exact' }] }, required: [['sourceId'], ['entities']], capped: [] },
  { name: 'expand', url: '/v1/graph/expand', body: { sourceId: FUZZ_SOURCE, ref: REF, neighborTypes: ['gadget'] }, required: [['sourceId'], ['ref'], ['ref', 'entityType'], ['ref', 'stableId'], ['neighborTypes']], capped: [] },
];

const clone = <T,>(value: T): T => structuredClone(value);
const at = (root: Record<string, unknown>, path: readonly string[]): Record<string, unknown> => path.slice(0, -1).reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, root);

describe('every read route', () => {
  it('serves its benign body, so the refusals below are the mutations and not the body', async () => {
    for (const route of ROUTES) {
      rig.reset();
      const response = await rig.post(route.url, route.body);
      expect(codeOf(response.body), route.name).not.toBe('INVALID_REQUEST');
    }
    rig.reset();
  });

  for (const route of ROUTES) {
    it(`${route.name}: a missing, mistyped or extra key is INVALID_REQUEST and reads nothing`, async () => {
      const mutation = fc.record({
        path: fc.constantFrom(...route.required),
        how: fc.constantFrom('remove', 'retype', 'extra'),
        wrong: wrongType,
        key: hostileText(known),
      });
      await fc.assert(
        fc.asyncProperty(mutation, async ({ path, how, wrong, key }) => {
          rig.reset();
          const body = clone(route.body);
          const parent = at(body, path);
          const last = path[path.length - 1] ?? '';
          if (how === 'remove') delete parent[last];
          else if (how === 'retype') parent[last] = wrong;
          else parent[key] = 'x';
          const response = await rig.post(route.url, body);
          expect(response.statusCode).toBe(400);
          expect(codeOf(response.body)).toBe('INVALID_REQUEST');
          expect(rig.executor.calls).toEqual([]);
        }),
        fuzzParams(80),
      );
    });

    for (const { path, over } of route.capped) {
      it(`${route.name}: ${path.join('.')} one over its cap (${over}) is INVALID_REQUEST and reads nothing`, async () => {
        rig.reset();
        const body = clone(route.body);
        at(body, path)[path[path.length - 1] ?? ''] = 'a'.repeat(over);
        const response = await rig.post(route.url, body);
        expect(codeOf(response.body)).toBe('INVALID_REQUEST');
        expect(rig.executor.calls).toEqual([]);
      });
    }
  }
});

describe('free-text fields', () => {
  interface Field {
    readonly name: string;
    readonly build: (text: string) => { readonly url: string; readonly body: Record<string, unknown> };
    /** The parameter the text must arrive in. */
    readonly parameter: string;
    readonly minLength: number;
    readonly maxLength: number;
  }
  const fields: readonly Field[] = [
    { name: 'search text', build: (text) => ({ url: '/v1/search/entities', body: { sourceId: FUZZ_SOURCE, text } }), parameter: 'text', minLength: 1, maxLength: 200 },
    { name: 'type-ahead text', build: (text) => ({ url: '/v1/search/entities', body: { sourceId: FUZZ_SOURCE, text, typeahead: true } }), parameter: 'text', minLength: 2, maxLength: 200 },
    { name: 'stable ID of a reference (lookup)', build: (text) => ({ url: '/v1/entities/lookup', body: { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: text } } }), parameter: 'stableId', minLength: 1, maxLength: 100_000 },
    { name: 'stable ID of a reference (degree preview)', build: (text) => ({ url: '/v1/graph/preview-expansion', body: { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: text } } }), parameter: 'stableId', minLength: 1, maxLength: 100_000 },
    { name: 'stable ID of a reference (expand)', build: (text) => ({ url: '/v1/graph/expand', body: { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: text }, neighborTypes: ['gadget'] } }), parameter: 'stableId', minLength: 1, maxLength: 100_000 },
    { name: 'value of a lookup', build: (text) => ({ url: '/v1/entities/lookup', body: { sourceId: FUZZ_SOURCE, value: { entityType: 'widget', value: text } } }), parameter: 'stableId', minLength: 1, maxLength: 100_000 },
  ];
  const holds = (value: string): boolean => rig.executor.calls.some((call) => call.parameters[fieldParameter.current] === value);
  const fieldParameter = { current: '' };
  const texts = fc.oneof(hostileText(names), fc.string({ unit: 'binary', minLength: 1, maxLength: 200 }), fc.constantFrom(...CYPHER_FRAGMENTS));

  for (const field of fields) {
    it(`${field.name}: is accepted, whatever the text, and reaches the executor as a parameter only`, async () => {
      const seen = { served: 0, parameter: 0 };
      fieldParameter.current = field.parameter;
      await fc.assert(
        fc.asyncProperty(texts.filter((text) => text !== ''), async (raw) => {
          const codePoints = [...raw];
          const text = (codePoints.length < field.minLength ? [...codePoints, ...'xx'.slice(0, field.minLength - codePoints.length)] : codePoints.slice(0, field.maxLength)).join('');
          const { url, body } = field.build(text);
          rig.reset();
          const response = await rig.post(url, body);
          expect(codeOf(response.body), JSON.stringify(text).slice(0, 60)).not.toBe('INVALID_REQUEST');
          expect(statementProblems(rig, closed, textLeaves(body, known))).toEqual([]);
          if (response.statusCode === 200) seen.served += 1;
          if (holds(text)) seen.parameter += 1;
          else expect(rig.executor.calls.some((call) => JSON.stringify(call.parameters).includes(JSON.stringify(text).slice(1, -1))), 'the text is in a parameter').toBe(true);
        }),
        fuzzParams(120),
      );
      expect(seen.parameter).toBeGreaterThan(20);
    });
  }

  it('accepts strings at the cap, the whole body within the 1 MiB bound, and the string is a parameter', async () => {
    const cases: readonly [string, Record<string, unknown>, string, string][] = [
      ['/v1/search/entities', { sourceId: FUZZ_SOURCE, text: 'n'.repeat(200) }, 'text', 'n'.repeat(200)],
      ['/v1/graph/preview-expansion', { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'q'.repeat(100_000) } }, 'stableId', 'q'.repeat(100_000)],
      ['/v1/entities/lookup', { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'q'.repeat(100_000) } }, 'stableId', 'q'.repeat(100_000)],
      ['/v1/entities/lookup', { sourceId: FUZZ_SOURCE, value: { entityType: 'widget', value: 'v'.repeat(100_000) } }, 'stableId', 'v'.repeat(100_000)],
    ];
    for (const [url, body, parameter, value] of cases) {
      rig.reset();
      const response = await rig.post(url, body);
      expect(codeOf(response.body), url).not.toBe('INVALID_REQUEST');
      expect(statementProblems(rig, closed, textLeaves(body, known))).toEqual([]);
      expect(rig.executor.calls.some((call) => call.parameters[parameter] === value), `${url} ${parameter}`).toBe(true);
    }
    rig.reset();
  });
});

describe('the stable ID of a type that is not keyed', () => {
  it('is read by the gate only up to 100,000 units: a longer one passes the route schema (cap 266,691, sized for a token) and is refused at validate, before any read', async () => {
    for (const url of ['/v1/graph/preview-expansion', '/v1/entities/lookup']) {
      for (const length of [100_001, 266_691]) {
        rig.reset();
        const response = await rig.post(url, { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'q'.repeat(length) } });
        expect(codeOf(response.body), `${url} ${length}`).toBe('INVALID_REQUEST');
        expect(rig.executor.calls).toEqual([]);
      }
    }
  });
});

describe('page size', () => {
  const expand = (limit: unknown) => ({ sourceId: FUZZ_SOURCE, ref: REF, neighborTypes: ['gadget'], limit });

  it('refuses a limit below 1, a non-integer and one beyond the safe integers with INVALID_REQUEST, reading nothing', async () => {
    for (const limit of [0, -1, -1000, 1.5, 2 ** 53, 1e300, null, '10', [], {}]) {
      rig.reset();
      const response = await rig.post('/v1/graph/expand', expand(limit));
      expect(codeOf(response.body), String(limit)).toBe('INVALID_REQUEST');
      expect(rig.executor.calls).toEqual([]);
    }
  });

  it('answers QUERY_BUDGET_EXCEEDED, naming the maximum, for a safe integer above it, and serves the maximum itself', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 51, max: Number.MAX_SAFE_INTEGER }), async (limit) => {
        rig.reset();
        const response = await rig.post('/v1/graph/expand', expand(limit));
        expect(response.statusCode).toBe(422);
        expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'QUERY_BUDGET_EXCEEDED', details: { maxPage: 50 } } });
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(100),
    );
    rig.reset();
    expect((await rig.post('/v1/graph/expand', expand(50))).statusCode).toBe(200);
  });

  it('refuses a limit on search more and more than 25 exact references, with INVALID_REQUEST', async () => {
    const more = { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, group: 'related', cursor: 'v1.x.y' };
    rig.reset();
    expect(codeOf((await rig.post('/v1/search/entities/more', { ...more, limit: 10 })).body)).toBe('INVALID_REQUEST');
    const refs = Array.from({ length: 26 }, (_, index) => ({ sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: `W-${index}` }));
    expect(codeOf((await rig.post('/v1/search/entities/more', { ...more, exactRefs: refs })).body)).toBe('INVALID_REQUEST');
    expect(rig.executor.calls).toEqual([]);
  });
});
