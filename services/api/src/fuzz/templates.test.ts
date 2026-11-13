import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { makeToken } from '../reference/token.js';
import { closedSetOf, statementProblems } from '../testing/fuzz-closed-set.js';
import { FIELD_NAMES, TEMPLATE_NATIVE, fuzzParams, hostileText, textLeaves, wrongType } from '../testing/fuzz-corpus.js';
import { FUZZ_ENTITIES, FUZZ_SOURCE, FUZZ_TIGHT_SOURCE, FUZZ_TWIN_SOURCE, allowedNames, startFuzzRig } from '../testing/fuzz-rig.js';
import { TEST_REFERENCE_KEYS } from '../testing/gate.js';

const names = new Set([...allowedNames(), 'widget', 'gadget', 'phone', 'holder', 'MADE_FROM', 'USES', 'HOLDS', 'out', 'in', 'both', FUZZ_SOURCE, FUZZ_TWIN_SOURCE, FUZZ_TIGHT_SOURCE, 'shared-gadgets', 'shared-phones', 'linked-gadgets', 'linked-widgets', 'shared-attribute', 'linked-entities']);
const known = new Set([...names, ...FIELD_NAMES, ...TEMPLATE_NATIVE, 'params', 'maxHops', 'attributeType', 'targetType', 'via', 'window', 'days', 'from', 'to', 'minShared']);
const rig = await startFuzzRig();
const closed = await closedSetOf(rig);

const codeOf = (body: string): string | undefined => {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
};

const ANCHOR = { entityType: 'widget', stableId: 'W-1' };
const SHARED_BY_ID = { attributeType: 'gadget', via: 'MADE_FROM' };
const LINKED_BY_ID = { targetType: 'gadget', via: ['MADE_FROM'] };

/** One run of a pattern route: the template or preset, the source, the parameters and what else the body holds. */
const run = (id: string, params: Record<string, unknown>, extra: { sourceId?: string; mask?: unknown } = {}) =>
  rig.post(`/v1/templates/${encodeURIComponent(id)}/run`, { sourceId: extra.sourceId ?? FUZZ_SOURCE, params, ...(extra.mask === undefined ? {} : { mask: extra.mask }) });

/** What every refused run owes: the code, no call to the source, and no statement that is outside the closed set or holds request text. */
const refused = (response: { readonly body: string }, code: string, request: unknown): void => {
  expect(codeOf(response.body)).toBe(code);
  expect(rig.executor.calls).toEqual([]);
  expect(statementProblems(rig, closed, textLeaves(request, known))).toEqual([]);
};

const unmapped = hostileText(names).filter((text) => text !== '');
const hostileId = fc.oneof(unmapped, fc.constantFrom('Widget', 'WIDGET', ' widget', 'widget ', 'sprocket', 'gizmo', 'widgetId', 'MADE_FROM '));

describe('the body of a run', () => {
  const inject = (payload: string, contentType = 'application/json') =>
    rig.app.inject({ method: 'POST', url: '/v1/templates/shared-gadgets/run', payload, headers: { 'content-type': contentType, 'idempotency-key': 'fuzz-key-of-sixteen-body' } });

  it('is refused when it is malformed JSON or over 1 MiB (INVALID_REQUEST), or is not JSON (UNSUPPORTED_MEDIA_TYPE), and nothing is read', async () => {
    const marker = 'ZZ-MARKER-ZZ';
    const body = { sourceId: FUZZ_SOURCE, params: { ref: ANCHOR } };
    const cases: readonly (readonly [string, { readonly body: string }, string])[] = [
      ['malformed JSON', await inject(`{"sourceId": "demo", "params": {"ref": "${marker}"`), 'INVALID_REQUEST'],
      ['a body over 1 MiB', await inject(JSON.stringify({ ...body, params: { ref: { ...ANCHOR, stableId: marker.repeat(100_000) } } })), 'INVALID_REQUEST'],
      ['application/xml', await inject(JSON.stringify(body), 'application/xml'), 'UNSUPPORTED_MEDIA_TYPE'],
      ['a form', await inject(JSON.stringify(body), 'application/x-www-form-urlencoded'), 'UNSUPPORTED_MEDIA_TYPE'],
      ['no content type', await rig.app.inject({ method: 'POST', url: '/v1/templates/shared-gadgets/run', payload: JSON.stringify(body), headers: { 'idempotency-key': 'fuzz-key-of-sixteen-body' } }), 'UNSUPPORTED_MEDIA_TYPE'],
    ];
    for (const [name, response, code] of cases) expect(codeOf(response.body), name).toBe(code);
    expect(rig.executor.calls).toEqual([]);
    expect(statementProblems(rig, closed, [marker])).toEqual([]);
  });
});

describe('the template or preset ID of a run', () => {
  it('that is none of the source\'s presets and none of the built-in templates is NOT_FOUND, however long it is, and nothing is read', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(hostileId, fc.string({ unit: 'binary', minLength: 1, maxLength: 5000 })), async (id) => {
        rig.reset();
        refused(await run(id, { ref: ANCHOR }), 'NOT_FOUND', { id });
      }),
      fuzzParams(80),
    );
  });
});

describe('hostile text in an input of a run', () => {
  const inputs: readonly { readonly name: string; readonly send: (text: string) => Promise<{ readonly body: string }>; readonly code: string }[] = [
    { name: 'the source ID', code: 'NOT_FOUND', send: (text) => run('shared-gadgets', { ref: ANCHOR }, { sourceId: text }) },
    { name: 'the entity type of the anchor (preset)', code: 'NOT_FOUND', send: (text) => run('shared-gadgets', { ref: { entityType: text, stableId: 'W-1' } }) },
    { name: 'the entity type of the anchor (linked-entities)', code: 'NOT_FOUND', send: (text) => run('linked-entities', { ref: { entityType: text, stableId: 'W-1' }, ...LINKED_BY_ID }) },
    { name: 'the attribute type', code: 'INVALID_REQUEST', send: (text) => run('shared-attribute', { ref: ANCHOR, attributeType: text, via: 'MADE_FROM' }) },
    { name: 'the relationship type of shared-attribute', code: 'INVALID_REQUEST', send: (text) => run('shared-attribute', { ref: ANCHOR, attributeType: 'gadget', via: text }) },
    { name: 'the target type', code: 'INVALID_REQUEST', send: (text) => run('linked-entities', { ref: ANCHOR, targetType: text, via: ['MADE_FROM'] }) },
    { name: 'an item of via of linked-entities', code: 'INVALID_REQUEST', send: (text) => run('linked-entities', { ref: ANCHOR, targetType: 'gadget', via: ['MADE_FROM', text] }) },
    { name: 'the direction', code: 'INVALID_REQUEST', send: (text) => run('linked-gadgets', { ref: ANCHOR, direction: text }) },
    { name: 'the start of a window of dates', code: 'INVALID_REQUEST', send: (text) => run('linked-gadgets', { ref: ANCHOR, window: { from: text, to: '2026-03-01' } }) },
    { name: 'the end of a window of dates', code: 'INVALID_REQUEST', send: (text) => run('shared-gadgets', { ref: ANCHOR, window: { from: '2026-03-01', to: text } }) },
  ];

  for (const input of inputs) {
    it(`${input.name}: is ${input.code}, reads nothing, and is in no statement`, async () => {
      await fc.assert(
        fc.asyncProperty(unmapped, async (text) => {
          rig.reset();
          refused(await input.send(text), input.code, { text });
        }),
        fuzzParams(60),
      );
    });
  }

  it('the stable ID of an anchor of a type that is not keyed: is served, whatever the text, and reaches the executor as a parameter only', async () => {
    const texts = fc.oneof(unmapped, fc.string({ unit: 'binary', minLength: 1, maxLength: 200 }));
    await fc.assert(
      fc.asyncProperty(texts, fc.constantFrom('shared-gadgets', 'shared-phones', 'linked-gadgets', 'linked-widgets'), async (text, preset) => {
        rig.reset();
        const response = await run(preset, { ref: { entityType: 'widget', stableId: text }, ...(preset === 'linked-widgets' ? { maxHops: 2, direction: 'both' } : {}) });
        expect(codeOf(response.body)).toBeUndefined();
        expect(rig.executor.calls.some((call) => call.parameters['stableId'] === text)).toBe(true);
        expect(statementProblems(rig, closed, textLeaves({ text }, known))).toEqual([]);
      }),
      fuzzParams(80),
    );
  });

  it('the stable ID of the longest anchor the gate reads (100,000 units): is a parameter, and one unit more is INVALID_REQUEST before any read', async () => {
    rig.reset();
    const long = 'q'.repeat(100_000);
    expect(codeOf((await run('shared-gadgets', { ref: { entityType: 'widget', stableId: long } })).body)).toBeUndefined();
    expect(rig.executor.calls.some((call) => call.parameters['stableId'] === long)).toBe(true);
    expect(statementProblems(rig, closed, [long])).toEqual([]);
    rig.reset();
    refused(await run('shared-gadgets', { ref: { entityType: 'widget', stableId: `${long}q` } }), 'INVALID_REQUEST', {});
  });

  it('is told to a statement-writing check: a statement that holds a text of the request is found', () => {
    const text = '`) DETACH DELETE n //';
    const statement = `MATCH (a:\`Widget\`) WHERE a.\`widgetId\` = '${text}' RETURN a`;
    const stand = { executor: { calls: [{ cypher: statement, parameters: {} }] } } as unknown as Parameters<typeof statementProblems>[0];
    expect(statementProblems(stand, closed, [text]).map((problem) => problem.reason)).toEqual(expect.arrayContaining([`holds request text ${JSON.stringify(text)}`, 'not in the closed set']));
    for (const piece of ['W-9', 'gadget-name', 'MADE_FROM_X', '2026-03-01', '3650']) {
      const written = { executor: { calls: [{ cypher: `MATCH (a:\`Widget\`) WHERE a.\`widgetId\` = ${piece} RETURN a`, parameters: {} }] } } as unknown as Parameters<typeof statementProblems>[0];
      expect(statementProblems(written, closed, [piece]).map((problem) => problem.reason), piece).toContain(`holds request text ${JSON.stringify(piece)}`);
    }
  });
});

describe('what the route refuses because of the mapping, the budgets or the token', () => {
  const wrongList = fc.oneof(wrongType.filter((value) => !Array.isArray(value) || value.some((item) => typeof item !== 'string')), fc.constant([]), fc.constantFrom('MADE_FROM', 'USES'));

  it('an unmapped entity type of the anchor is NOT_FOUND', async () => {
    await fc.assert(
      fc.asyncProperty(hostileId, fc.constantFrom('shared-gadgets', 'linked-gadgets'), async (entityType, id) => {
        rig.reset();
        refused(await run(id, { ref: { entityType, stableId: 'W-1' } }), 'NOT_FOUND', { entityType });
      }),
      fuzzParams(60),
    );
  });

  it('an attribute, target or relationship type the mapping does not join is INVALID_REQUEST', async () => {
    await fc.assert(
      fc.asyncProperty(hostileId, async (text) => {
        for (const [id, params] of [
          ['shared-attribute', { ref: ANCHOR, attributeType: text, via: 'MADE_FROM' }],
          ['shared-attribute', { ref: ANCHOR, attributeType: 'gadget', via: text }],
          ['shared-attribute', { ref: ANCHOR, attributeType: 'phone', via: 'MADE_FROM' }],
          ['linked-entities', { ref: ANCHOR, targetType: text, via: ['MADE_FROM'] }],
          ['linked-entities', { ref: ANCHOR, targetType: 'gadget', via: [text] }],
          ['linked-entities', { ref: ANCHOR, targetType: 'gadget', via: ['USES'] }],
        ] as const) {
          rig.reset();
          refused(await run(id, params), 'INVALID_REQUEST', { text });
        }
      }),
      fuzzParams(40),
    );
  });

  it('a preset that also receives the types it binds is INVALID_REQUEST', async () => {
    for (const [id, extra] of [
      ['shared-gadgets', { attributeType: 'gadget' }],
      ['shared-gadgets', { via: 'MADE_FROM' }],
      ['linked-gadgets', { targetType: 'gadget' }],
      ['linked-gadgets', { via: ['MADE_FROM'] }],
    ] as const) {
      rig.reset();
      refused(await run(id, { ref: ANCHOR, ...extra }), 'INVALID_REQUEST', {});
    }
  });

  it('a list of relationship types that is not a non-empty list of texts is INVALID_REQUEST', async () => {
    await fc.assert(
      fc.asyncProperty(wrongList, async (via) => {
        rig.reset();
        refused(await run('linked-entities', { ref: ANCHOR, targetType: 'gadget', via }), 'INVALID_REQUEST', { via });
      }),
      fuzzParams(60),
    );
  });

  it('hops above the cap are QUERY_BUDGET_EXCEEDED, never clipped; hops that are not a whole number from 1 to the schema bound are INVALID_REQUEST', async () => {
    rig.reset();
    for (const maxHops of [3, 4]) {
      rig.reset();
      const over = await run('linked-gadgets', { ref: ANCHOR, maxHops });
      expect(over.statusCode).toBe(422);
      refused(over, 'QUERY_BUDGET_EXCEEDED', {});
      expect(over.body).toMatch(/"maxHops":2/);
    }
    rig.reset();
    const tight = await run('linked-gadgets', { ref: ANCHOR, maxHops: 2 }, { sourceId: FUZZ_TIGHT_SOURCE });
    refused(tight, 'QUERY_BUDGET_EXCEEDED', {});
    expect(tight.body).toMatch(/"maxHops":1/);
    rig.reset();
    expect(codeOf((await run('linked-gadgets', { ref: ANCHOR, maxHops: 1 }, { sourceId: FUZZ_TIGHT_SOURCE })).body)).toBeUndefined();
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.integer({ max: 0 }), fc.integer({ min: 5 }), fc.double({ noInteger: true, noNaN: true }), wrongType.filter((value) => typeof value !== 'number')), async (maxHops) => {
        rig.reset();
        refused(await run('linked-gadgets', { ref: ANCHOR, maxHops }), 'INVALID_REQUEST', { maxHops });
      }),
      fuzzParams(80),
    );
  });

  it('a window that is not days from 1 to 3650 or a range of calendar dates in order, at most 3650 days, is INVALID_REQUEST', async () => {
    const badWindow = fc.oneof(
      fc.integer({ max: 0 }).map((days) => ({ days })),
      fc.integer({ min: 3651 }).map((days) => ({ days })),
      fc.double({ noInteger: true, noNaN: true }).map((days) => ({ days })),
      fc.constantFrom({ from: '2026-02-30', to: '2026-03-01' }, { from: '2026-03-02', to: '2026-03-01' }, { from: '2026-3-1', to: '2026-03-02' }, { from: '2026-03-01' }, { to: '2026-03-01' }, { from: '2010-01-01', to: '2026-03-01' }, { days: 3, from: '2026-03-01', to: '2026-03-02' }, {}, { days: '3' }),
      hostileText(known).map((from) => ({ from, to: '2026-03-01' })),
      wrongType,
    );
    await fc.assert(
      fc.asyncProperty(badWindow, fc.constantFrom('shared-gadgets', 'linked-gadgets'), async (window, id) => {
        rig.reset();
        refused(await run(id, { ref: ANCHOR, window }), 'INVALID_REQUEST', { window });
      }),
      fuzzParams(120),
    );
  });

  it('a window over a relationship type with no mapped time property is INVALID_REQUEST, and without a window the same run is served', async () => {
    rig.reset();
    const windowed = await run('linked-holders', { ref: { entityType: 'widget', stableId: 'W-1' }, window: { days: 30 } }, { sourceId: FUZZ_TIGHT_SOURCE });
    refused(windowed, 'INVALID_REQUEST', {});
    rig.reset();
    expect(codeOf((await run('linked-holders', { ref: ANCHOR }, { sourceId: FUZZ_TIGHT_SOURCE })).body)).toBeUndefined();
  });

  it('a limit that is not a whole number of at least 1 is INVALID_REQUEST; a limit above the source\'s page maximum is QUERY_BUDGET_EXCEEDED naming it; a minimum of shared nodes outside 1 to 50 is INVALID_REQUEST', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.integer({ max: 0 }), fc.double({ noInteger: true, noNaN: true }), fc.constant(Number.MAX_SAFE_INTEGER * 2), wrongType.filter((value) => typeof value !== 'number')), fc.constantFrom('shared-gadgets', 'linked-gadgets'), async (limit, id) => {
        rig.reset();
        refused(await run(id, { ref: ANCHOR, limit }), 'INVALID_REQUEST', {});
      }),
      fuzzParams(80),
    );
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 51, max: 1_000_000 }), fc.constantFrom('shared-gadgets', 'linked-gadgets'), async (limit, id) => {
        rig.reset();
        const response = await run(id, { ref: ANCHOR, limit });
        refused(response, 'QUERY_BUDGET_EXCEEDED', {});
        expect(response.body).toMatch(/"maxPage":50/);
      }),
      fuzzParams(40),
    );
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.integer({ max: 0 }), fc.integer({ min: 51 }), fc.double({ noInteger: true, noNaN: true }), wrongType.filter((value) => typeof value !== 'number')), async (minShared) => {
        rig.reset();
        refused(await run('shared-gadgets', { ref: ANCHOR, minShared }), 'INVALID_REQUEST', { minShared });
      }),
      fuzzParams(80),
    );
  });

  describe('the stable ID of a keyed entity type', () => {
    const PHONE = '+1-212-555-0100';
    const tokenFor = (place: { sourceId?: string; entityType?: string } = {}) => makeToken(TEST_REFERENCE_KEYS, { sourceId: place.sourceId ?? FUZZ_SOURCE, entityType: place.entityType ?? 'phone' }, `${PHONE}`);
    const good = tokenFor();
    const byPhone = (stableId: string) => run('linked-entities', { ref: { entityType: 'phone', stableId }, targetType: 'widget', via: ['USES'], direction: 'in' });
    const forged = fc.oneof(
      fc.string({ unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'), maxLength: 90 }).map((text) => `p1.${text}`),
      fc.nat(good.length).map((cut) => good.slice(0, cut)),
      fc.constantFrom(`${good}=`, 'p1.', `p2.${good.slice(3)}`, '+1-212-555-0100', 'plain'),
      hostileText(known),
    ).filter((text) => text !== good);

    it('is served when it is a token this server made for that source and type', async () => {
      rig.reset();
      expect(codeOf((await byPhone(good)).body)).toBeUndefined();
    });

    it('that is forged, truncated, extended or another spelling is INVALID_REQUEST and nothing is read', async () => {
      await fc.assert(
        fc.asyncProperty(forged, async (stableId) => {
          rig.reset();
          refused(await byPhone(stableId), 'INVALID_REQUEST', { stableId });
        }),
        fuzzParams(120),
      );
    });

    it('that was made for another source or another type is INVALID_REQUEST and nothing is read, the twin source\'s included', async () => {
      for (const stableId of [tokenFor({ sourceId: FUZZ_TWIN_SOURCE }), tokenFor({ sourceId: 'other' }), tokenFor({ entityType: 'holder' }), tokenFor({ entityType: 'widget' })]) {
        rig.reset();
        refused(await byPhone(stableId), 'INVALID_REQUEST', {});
      }
    });
  });

  it('an unknown source is NOT_FOUND, and the run route has no reference that names another source (the anchor carries no source ID), so there is no SOURCE_MISMATCH to send', async () => {
    rig.reset();
    refused(await run('shared-gadgets', { ref: ANCHOR }, { sourceId: 'no-such-source' }), 'NOT_FOUND', {});
    rig.reset();
    refused(await run('shared-gadgets', { ref: { ...ANCHOR, sourceId: FUZZ_TWIN_SOURCE } }), 'INVALID_REQUEST', {});
  });

  it('an Idempotency-Key that is missing, too short or has characters outside the allowed set is INVALID_REQUEST and nothing is read', async () => {
    const send = (headers: Record<string, string>) => rig.app.inject({ method: 'POST', url: '/v1/templates/shared-gadgets/run', payload: JSON.stringify({ sourceId: FUZZ_SOURCE, params: { ref: ANCHOR } }), headers: { 'content-type': 'application/json', ...headers } });
    refused(await send({}), 'INVALID_REQUEST', {});
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string({ maxLength: 15 }).filter((text) => !/[\r\n\u0000]/.test(text)), fc.constantFrom('has spaces in it so bad!!', 'ключ-ключ-ключ-ключ', 'a'.repeat(300))), async (key) => {
        rig.reset();
        const response = await send({ 'idempotency-key': key });
        refused(response, 'INVALID_REQUEST', {});
      }),
      fuzzParams(60),
    );
  });
});
