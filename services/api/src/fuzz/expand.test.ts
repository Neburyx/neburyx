import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FUZZ_SOURCE, allowedNames, startFuzzRig } from '../testing/fuzz-rig.js';
import { benignValuesOf, closedSetOf, leaksOf, quotedNamesOf, statementProblems } from '../testing/fuzz-closed-set.js';
import { FIELD_NAMES, TEMPLATE_NATIVE, fuzzParams, hostileText, textLeaves, wrongType } from '../testing/fuzz-corpus.js';

const names = new Set([...allowedNames(), 'widget', 'gadget', 'phone', 'MADE_FROM', 'USES', 'out', 'in', 'both', 'observed', FUZZ_SOURCE]);
const known = new Set([...names, ...FIELD_NAMES, ...TEMPLATE_NATIVE]);
const rig = await startFuzzRig();
const closed = await closedSetOf(rig);

/** The good value, except in `percent` of the draws, where it is hostile text. */
const sometimes = (good: string, percent: number): fc.Arbitrary<string> => fc.tuple(fc.integer({ min: 0, max: 99 }), hostileText(names)).map(([draw, text]) => (draw < percent ? text : good));
const textOr = (good: readonly string[]): fc.Arbitrary<string> => fc.tuple(fc.integer({ min: 0, max: 99 }), fc.constantFrom(...good), hostileText(names)).map(([draw, name, text]) => (draw < 6 ? text : name));
/** The good value, except in `percent` of the draws, where it is the bad one; the good value may be absent (undefined). */
const mostly = <Good, Bad>(good: fc.Arbitrary<Good>, bad: fc.Arbitrary<Bad>, percent: number): fc.Arbitrary<Good | Bad> => fc.tuple(fc.integer({ min: 0, max: 99 }), good, bad).map(([draw, fine, other]) => (draw < percent ? other : fine));
/** A list of distinct allowed names, where now and then one is replaced by hostile text or repeated. */
const listOf = (good: readonly string[]): fc.Arbitrary<string[]> =>
  fc.tuple(fc.subarray([...good], { minLength: 1 }), fc.integer({ min: 0, max: 99 }), hostileText(names)).map(([list, draw, text]) => (draw < 6 ? [...list.slice(1), text] : draw < 10 ? [...list, ...list.slice(0, 1)] : list));

/** Expand bodies in which each field is either allowlisted or, now and then, hostile. */
const bodyOf = (): fc.Arbitrary<Record<string, unknown>> => fc
  .record({
    sourceId: sometimes(FUZZ_SOURCE, 6),
    entityType: textOr(['widget', 'gadget']),
    stableId: sometimes('W-1', 30),
    relTypes: fc.option(listOf(['MADE_FROM', 'USES']), { nil: undefined }),
    neighborTypes: listOf(['gadget', 'phone']),
    direction: mostly(fc.option(fc.constantFrom('out', 'in', 'both'), { nil: undefined, freq: 2 }), hostileText(names), 6),
    limit: mostly(fc.option(fc.integer({ min: 1, max: 50 }), { nil: undefined, freq: 2 }), fc.oneof(fc.constant(0), fc.integer({ min: -1000, max: -1 }), fc.double(), fc.integer({ min: 51, max: 10_000 }), fc.constant(2 ** 53), wrongType), 12),
    cursors: mostly(fc.constant(undefined), fc.dictionary(textOr(['gadget', 'phone']), fc.oneof(hostileText(names), wrongType), { maxKeys: 2 }), 8),
    mask: mostly(fc.option(fc.boolean(), { nil: undefined, freq: 2 }), wrongType, 6),
  })
  .map((fields) => ({ sourceId: fields.sourceId, ref: { entityType: fields.entityType, stableId: fields.stableId }, neighborTypes: fields.neighborTypes, ...(fields.relTypes === undefined ? {} : { relTypes: fields.relTypes }), ...(fields.direction === undefined ? {} : { direction: fields.direction }), ...(fields.limit === undefined ? {} : { limit: fields.limit }), ...(fields.cursors === undefined ? {} : { cursors: fields.cursors }), ...(fields.mask === undefined ? {} : { mask: fields.mask }) }));

describe('the closed set of statement text', () => {
  it('holds statements that quote only the names the mapping allows', () => {
    expect(closed.size).toBeGreaterThan(10);
    const allowed = allowedNames();
    for (const statement of closed) for (const quoted of quotedNamesOf(statement)) expect(allowed.has(quoted), `${quoted} in ${statement}`).toBe(true);
  });

  it('holds the statement of each template a benign request reaches, the index-snapshot read included', async () => {
    rig.reset();
    const response = await rig.post('/v1/graph/expand', { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes: ['gadget'], limit: 2 });
    expect(response.statusCode).toBe(200);
    expect(new Set(rig.executor.calls.map((call) => call.templateId))).toEqual(new Set(['schema-indexes', 'expand-neighbors']));
    expect(statementProblems(rig, closed, [])).toEqual([]);
    rig.reset();
  });

  it('holds no value that was used to build it, and a statement that holds one is found', () => {
    const values = benignValuesOf.get(closed) ?? [];
    expect(values.length).toBeGreaterThan(5);
    expect(leaksOf(closed, values)).toEqual([]);
    expect(leaksOf(new Set(["MATCH (n:`Widget`) WHERE n.`widgetId` = 'W-1' RETURN n"]), values)).not.toEqual([]);
    expect(leaksOf(new Set(["MATCH (n) WHERE n.x = 'ne'"]), values)).not.toEqual([]);
  });

  it('fails a statement that was built from text, a quoted name that is not allowed, and a statement that holds request text', () => {
    rig.reset();
    rig.executor.calls.push({ cypher: 'MATCH (n:`Widget`) WHERE n.`widgetId` = \'x\' OR 1=1 RETURN n' } as never, { cypher: 'MATCH (n:`Wi``dget`) RETURN n' } as never);
    const problems = statementProblems(rig, closed, ['OR 1=1']);
    expect(problems.map((problem) => problem.reason)).toEqual(expect.arrayContaining(['not in the closed set', expect.stringContaining('holds request text'), expect.stringContaining('quotes')]));
    rig.reset();
  });
});

const expandBody = bodyOf() as unknown as fc.Arbitrary<Body>;
interface Body {
  sourceId: string;
  ref: { entityType: string; stableId: string };
  neighborTypes: string[];
  relTypes?: string[];
  direction?: unknown;
  limit?: unknown;
  cursors?: Record<string, unknown>;
  mask?: unknown;
}

const TYPES = ['gadget', 'phone'];
const RELS = ['MADE_FROM', 'USES'];

/** The code the request must answer, in the order the service checks: the body's shape, the source, the names, then the page size. `undefined` where the combination of allowed names is for the mapping to decide. */
function expectedCode(body: Body): string | undefined {
  const shape = body as unknown as Record<string, unknown>;
  const mask = shape['mask'];
  const limit = shape['limit'];
  const cursors = shape['cursors'];
  const direction = shape['direction'];
  const wrongShape =
    (mask !== undefined && typeof mask !== 'boolean') ||
    (limit !== undefined && !Number.isSafeInteger(limit)) ||
    (direction !== undefined && !['out', 'in', 'both'].includes(String(direction))) ||
    (typeof cursors === 'object' && cursors !== null && Object.values(cursors).some((cursor) => typeof cursor !== 'string' || cursor === '')) ||
    body.sourceId === '' || body.ref.entityType === '' || body.ref.stableId === '' || body.neighborTypes.some((type) => type === '') || (body.relTypes ?? []).some((type) => type === '');
  if (wrongShape) return 'INVALID_REQUEST';
  if (body.sourceId !== FUZZ_SOURCE) return 'NOT_FOUND';
  const duplicate = new Set(body.neighborTypes).size !== body.neighborTypes.length || new Set(body.relTypes ?? []).size !== (body.relTypes ?? []).length;
  const stray = Object.keys(body.cursors ?? {}).some((type) => !body.neighborTypes.includes(type));
  const unmapped = !['widget', 'gadget'].includes(body.ref.entityType) || !body.neighborTypes.every((type) => TYPES.includes(type)) || !(body.relTypes ?? []).every((type) => RELS.includes(type));
  if (duplicate || stray || unmapped) return 'INVALID_REQUEST';
  return undefined;
}

describe('a failing run', () => {
  it('reports the fixed seed and the shrunk input so the case replays', async () => {
    const result = await fc.check(fc.asyncProperty(fc.integer({ min: 0, max: 1000 }), (n) => Promise.resolve(n < 10)), fuzzParams(200));
    expect(result.failed).toBe(true);
    expect(result.seed).toBe(5017);
    expect(result.counterexample).toEqual([10]);
  });
});

describe('POST /v1/graph/expand with hostile input', () => {
  it('reaches the executor for some bodies and refuses others, so both sides are exercised', async () => {
    const seen = { read: 0, refused: 0 };
    await fc.assert(
      fc.asyncProperty(expandBody, async (body) => {
        rig.reset();
        await rig.post('/v1/graph/expand', body);
        if (rig.executor.calls.length > 0) seen.read += 1;
        else seen.refused += 1;
      }),
      fuzzParams(300),
    );
    expect(seen.read).toBeGreaterThan(10);
    expect(seen.refused).toBeGreaterThan(10);
  });

  it('writes only statements of the closed set, never request text, and refuses what the mapping does not allow before any read', async () => {
    await fc.assert(
      fc.asyncProperty(expandBody, async (body) => {
        rig.reset();
        const response = await rig.post('/v1/graph/expand', body);
        const code = (response.json() as { error?: { code: string } }).error?.code;
        expect(code).not.toBe('RATE_LIMITED');
        expect(statementProblems(rig, closed, textLeaves(body, known))).toEqual([]);
        const expected = expectedCode(body);
        if (expected !== undefined) {
          expect(code).toBe(expected);
          expect(rig.executor.calls).toEqual([]);
        } else {
          expect([undefined, 'INVALID_REQUEST', 'CURSOR_INVALIDATED', 'QUERY_BUDGET_EXCEEDED', 'NOT_FOUND']).toContain(code);
        }
      }),
      fuzzParams(300),
    );
  });
});
