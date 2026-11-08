import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CURSOR_TTL_MS } from '../gate/cursor/codec.js';
import { closedSetOf, statementProblems } from '../testing/fuzz-closed-set.js';
import { FIELD_NAMES, TEMPLATE_NATIVE, fuzzParams, hostileText, textLeaves, wrongType } from '../testing/fuzz-corpus.js';
import { FUZZ_SOURCE, FUZZ_TEXT, FUZZ_TWIN_SOURCE, allowedNames, payloadOfCursor, signCursor, startFuzzRig } from '../testing/fuzz-rig.js';

const names = new Set([...allowedNames(), 'widget', 'gadget', 'phone', 'holder', FUZZ_SOURCE, FUZZ_TWIN_SOURCE]);
const known = new Set([...names, ...FIELD_NAMES, ...TEMPLATE_NATIVE]);
const rig = await startFuzzRig();
const closed = await closedSetOf(rig);

const parse = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;
const codeOf = (body: string): string | undefined => (parse(body)['error'] as { code?: string } | undefined)?.code;
const withoutTrace = (body: string): string => body.replace(/"traceId":"[^"]*"/, '"traceId":"-"');

const expandBody = (extra: Record<string, unknown> = {}, cursors?: Record<string, string>, neighborTypes = ['gadget']) => ({ sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes, limit: 2, ...(cursors === undefined ? {} : { cursors }), ...extra });
const moreBody = (group: string, cursor: string, extra: Record<string, unknown> = {}) => ({ sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, group, cursor, ...extra });

async function mintExpand(neighborType = 'gadget', extra: Record<string, unknown> = {}): Promise<string> {
  const response = await rig.post('/v1/graph/expand', expandBody(extra, undefined, [neighborType]));
  const cursor = ((parse(response.body)['pages'] as { nextCursor?: string }[])[0])?.nextCursor;
  if (cursor === undefined) throw new Error('the expansion has no next page');
  return cursor;
}

async function mintMore(group: 'exact' | 'related', extra: Record<string, unknown> = {}): Promise<string> {
  const response = await rig.post('/v1/search/entities', { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, ...extra });
  const body = parse(response.body);
  const cursor = group === 'exact' ? (body['exactNextCursor'] as string | undefined) : (body[group] as { nextCursor?: string } | undefined)?.nextCursor;
  if (cursor === undefined) throw new Error(`the ${group} group has no next page`);
  return cursor;
}

interface Kind {
  readonly name: string;
  readonly mint: () => Promise<string>;
  readonly send: (cursor: string) => Promise<{ readonly body: string; readonly statusCode: number }>;
}

const KINDS: readonly Kind[] = [
  { name: 'expand', mint: () => mintExpand(), send: (cursor) => rig.post('/v1/graph/expand', expandBody({}, { gadget: cursor })) },
  { name: 'search more (exact)', mint: () => mintMore('exact'), send: (cursor) => rig.post('/v1/search/entities/more', moreBody('exact', cursor)) },
  { name: 'search more (related)', mint: () => mintMore('related'), send: (cursor) => rig.post('/v1/search/entities/more', moreBody('related', cursor)) },
];

/** A refused cursor reads nothing: the gate verifies it in the validate stage, before the index guard. Search more reads the index snapshot before it hands the cursor to the gate, and that is its one call. */
const expectRefused = (response: { readonly body: string }, label: string): void => {
  expect(codeOf(response.body), label).toBe('CURSOR_INVALIDATED');
  const calls = rig.executor.calls.map((call) => call.templateId);
  expect(calls, label).toEqual(rig.last.url === '/v1/search/entities/more' && calls.length > 0 ? ['schema-indexes'] : []);
};

const mutations = (cursor: string, other: string): fc.Arbitrary<string> => {
  const parts = cursor.split('.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_+/=.';
  return fc
    .oneof(
      fc.tuple(fc.nat(cursor.length - 1), fc.constantFrom(...alphabet)).map(([at, char]) => `${cursor.slice(0, at)}${char}${cursor.slice(at + 1)}`),
      fc.integer({ min: 1, max: cursor.length - 1 }).map((at) => cursor.slice(0, at)),
      hostileText(known).map((tail) => cursor + tail),
      fc.constantFrom(...['v2', 'V1', '', 'v1v1', 'p1']).map((version) => [version, ...parts.slice(1)].join('.')),
      fc.constantFrom(parts.slice(0, 2).join('.'), `${cursor}.extra`, `.${cursor}`, `${cursor}.`, parts.slice(1).join('.'), `${parts[0]}..${parts[2]}`),
      fc.constant(`${parts[0]}.${parts[1]}=.${parts[2]}`),
      fc.constant(`${parts[0]}.${parts[1]}.${parts[2]}=`),
      fc.constant(`${parts[0]}.${(parts[1] ?? '').replaceAll('-', '+').replaceAll('_', '/')}.${parts[2]}`),
      fc.constant(`${parts[0]}.${parts[1]}.${(parts[2] ?? '').replaceAll('-', '+').replaceAll('_', '/')}`),
      fc.constant(`${parts[0]}.${other.split('.')[1]}.${parts[2]}`),
      fc.constant(`${parts[0]}.${parts[1]}.${other.split('.')[2]}`),
    )
    .filter((mutated) => mutated !== cursor);
};

describe('a cursor that is edited', () => {
  for (const kind of KINDS) {
    it(`${kind.name}: every mutation answers CURSOR_INVALIDATED with one body, and reads nothing`, async () => {
      const cursor = await kind.mint();
      const other = await mintExpand('phone');
      const bodies = new Set<string>();
      await fc.assert(
        fc.asyncProperty(mutations(cursor, other), async (mutated) => {
          rig.reset();
          const response = await kind.send(mutated);
          expectRefused(response, mutated.slice(0, 40));
          bodies.add(withoutTrace(response.body));
        }),
        fuzzParams(250),
      );
      expect(bodies.size).toBe(1);
    });
  }
});

describe('a cursor signed with the right key and the wrong shape', () => {
  /** Values that are wrong for the field: a text field takes no number, null, list or record; the expiry no text, null, list, record or fraction; the position no flat value. */
  const wrongFor = (key: string): fc.Arbitrary<unknown> => (key === 'e' ? fc.constantFrom('x', null, [], {}, true, 1.5) : key === 'd' ? fc.constantFrom('x', null, [], 7, true, [1], { n: [] }) : fc.constantFrom(7, null, [], {}, true, ['a']));
  const ok = (kind: Kind) => kind.mint().then((cursor) => payloadOfCursor(cursor));
  const shape = (payload: Record<string, unknown>): fc.Arbitrary<unknown> =>
    fc.oneof(
      fc.constantFrom('s', 'p', 'pv', 'f', 'o', 't', 'tv', 'e', 'd').chain((key) => fc.oneof(fc.constant(Object.fromEntries(Object.entries(payload).filter(([name]) => name !== key))), wrongFor(key).map((value) => ({ ...payload, [key]: value })))),
      hostileText(known).map((key) => ({ ...payload, [key]: 1 })),
      fc.constantFrom([], 'text', 7, null, true).map((value) => value),
      fc.constantFrom([1], { n: 1 }, [[]], [{}]).map((value) => ({ ...payload, d: { ...(payload['d'] as object), x: value } })),
      fc.constantFrom({ n: { n: 1 } }, { n: [1] }).map((position) => ({ ...payload, d: position })),
      fc.constantFrom('{"n":1e999}', '{"n":-1e999}').map((position) => JSON.stringify(payload).replace(/"d":\{[^}]*\}/, `"d":${position}`)),
      fc.constant({ ...payload, d: [1, 2] }),
      fc.constant({ ...payload, e: 1.5 }),
    );

  for (const kind of KINDS) {
    it(`${kind.name}: is CURSOR_INVALIDATED and reads nothing`, async () => {
      const payload = await ok(kind);
      await fc.assert(
        fc.asyncProperty(shape(payload), async (candidate) => {
          rig.reset();
          expectRefused(await kind.send(signCursor(candidate)), JSON.stringify(candidate).slice(0, 60));
        }),
        fuzzParams(150),
      );
      rig.reset();
      const proto = JSON.stringify(payload).replace(/"d":\{/, '"d":{"__proto__":{"polluted":1},');
      expectRefused(await kind.send(signCursor(proto)), '__proto__');
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });
  }

  it('a payload that is right in shape and holds hostile strings passes the codec, and the strings reach the executor only as parameters', async () => {
    const cursor = await mintExpand();
    const payload = payloadOfCursor(cursor);
    const position = payload['d'] as Record<string, unknown>;
    const seen = { served: 0 };
    await fc.assert(
      fc.asyncProperty(hostileText(known).filter((text) => text !== ''), async (text) => {
        rig.reset();
        const hostile = { ...payload, d: Object.fromEntries(Object.entries(position).map(([key, value]) => [key, typeof value === 'string' ? text : value])) };
        const response = await rig.post('/v1/graph/expand', expandBody({}, { gadget: signCursor(hostile) }));
        const code = codeOf(response.body);
        expect(['CURSOR_INVALIDATED', 'INVALID_REQUEST', undefined]).toContain(code);
        expect(statementProblems(rig, closed, textLeaves({ text }, known))).toEqual([]);
        if (code === undefined) {
          seen.served += 1;
          const sent = rig.executor.calls.find((call) => call.templateId === 'expand-neighbors')?.parameters['cursor'];
          expect(JSON.stringify(sent)).toContain(JSON.stringify(text).slice(1, -1));
        }
      }),
      fuzzParams(100),
    );
    expect(seen.served).toBeGreaterThan(20);
  });
});

describe('a cursor replayed outside the scope it was minted for', () => {
  it('another source, principal, policy version, template, template version or sort (signed right) is CURSOR_INVALIDATED and reads nothing', async () => {
    for (const kind of KINDS) {
      const payload = payloadOfCursor(await kind.mint());
      for (const field of ['s', 'p', 'pv', 'f', 'o', 't', 'tv']) {
        rig.reset();
        expectRefused(await kind.send(signCursor({ ...payload, [field]: field === 's' ? FUZZ_TWIN_SOURCE : `${String(payload[field])}-other` })), `${kind.name} ${field}`);
      }
    }
  });

  it('the cursor of one source sent against the twin source is CURSOR_INVALIDATED', async () => {
    const expand = await mintExpand();
    rig.reset();
    expectRefused(await rig.post('/v1/graph/expand', { ...expandBody({}, { gadget: expand }), sourceId: FUZZ_TWIN_SOURCE }), 'expand');
    const more = await mintMore('exact');
    rig.reset();
    expectRefused(await rig.post('/v1/search/entities/more', { ...moreBody('exact', more), sourceId: FUZZ_TWIN_SOURCE }), 'more');
  });

  it('a changed bound parameter is CURSOR_INVALIDATED: for expand the ref, neighbor type, relationship types, direction and mask; for search more the text, group and entity types', async () => {
    const expand = await mintExpand();
    const cases: [string, () => Promise<{ readonly body: string }>][] = [
      ['ref', () => rig.post('/v1/graph/expand', expandBody({ ref: { entityType: 'widget', stableId: 'W-2' } }, { gadget: expand }))],
      ['direction', () => rig.post('/v1/graph/expand', expandBody({ direction: 'out' }, { gadget: expand }))],
      ['relationship types', () => rig.post('/v1/graph/expand', expandBody({ relTypes: ['MADE_FROM'] }, { gadget: expand }))],
      ['mask', () => rig.post('/v1/graph/expand', expandBody({ mask: true }, { gadget: expand }))],
      ['neighbor type', () => rig.post('/v1/graph/expand', expandBody({}, { phone: expand }, ['phone']))],
    ];
    const exact = await mintMore('exact');
    const related = await mintMore('related');
    cases.push(
      ['text', () => rig.post('/v1/search/entities/more', moreBody('exact', exact, { text: 'other-text' }))],
      ['entity types', () => rig.post('/v1/search/entities/more', moreBody('exact', exact, { entityTypes: ['gadget'] }))],
      ['mask (search)', () => rig.post('/v1/search/entities/more', moreBody('exact', exact, { mask: true }))],
      ['group (exact cursor to related)', () => rig.post('/v1/search/entities/more', moreBody('related', exact))],
      ['group (related cursor to exact)', () => rig.post('/v1/search/entities/more', moreBody('exact', related))],
      ['group (related cursor to evidence)', () => rig.post('/v1/search/entities/more', moreBody('evidence', related))],
    );
    for (const [name, send] of cases) {
      rig.reset();
      expectRefused(await send(), name);
    }
  });

  it('an expand cursor under a type that is not listed is INVALID_REQUEST', async () => {
    rig.reset();
    const cursor = await mintExpand();
    rig.reset();
    const response = await rig.post('/v1/graph/expand', expandBody({}, { phone: cursor }, ['gadget']));
    expect(codeOf(response.body)).toBe('INVALID_REQUEST');
    expect(rig.executor.calls).toEqual([]);
  });

  it('a changed limit or exactRefs is not bound: the page is served', async () => {
    const expand = await mintExpand();
    expect((await rig.post('/v1/graph/expand', expandBody({ limit: 3 }, { gadget: expand }))).statusCode).toBe(200);
    const related = await mintMore('related');
    const withRefs = await rig.post('/v1/search/entities/more', moreBody('related', related, { exactRefs: [{ sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-1' }] }));
    expect(withRefs.statusCode).toBe(200);
  });

  it('after the policy version changes, or after 30 minutes, every cursor is CURSOR_INVALIDATED', async () => {
    for (const kind of KINDS) {
      const cursor = await kind.mint();
      rig.reset();
      rig.policy.version = 'p2';
      expectRefused(await kind.send(cursor), `${kind.name} policy`);
      rig.policy.version = 'p1';
      rig.reset();
      expect((await kind.send(cursor)).statusCode, `${kind.name} unchanged`).toBe(200);
      rig.clock.advance(CURSOR_TTL_MS - 1);
      rig.reset();
      expect((await kind.send(cursor)).statusCode, `${kind.name} just before expiry`).toBe(200);
      rig.clock.advance(1);
      rig.reset();
      expectRefused(await kind.send(cursor), `${kind.name} expired`);
    }
  });

  it('replayed unchanged in the same scope within 30 minutes, the page is served again', async () => {
    for (const kind of KINDS) {
      const cursor = await kind.mint();
      for (let round = 0; round < 3; round += 1) expect((await kind.send(cursor)).statusCode, `${kind.name} ${round}`).toBe(200);
    }
  });
});

describe('a validly signed position whose keyed token does not read back', () => {
  it('is CURSOR_INVALIDATED and reads nothing', async () => {
    const cursor = await mintExpand('phone');
    const payload = payloadOfCursor(cursor);
    const position = payload['d'] as Record<string, unknown>;
    const tokenFields = Object.entries(position).filter(([, value]) => typeof value === 'string' && value.startsWith('p1.'));
    expect(tokenFields.length).toBeGreaterThan(0);
    const request = (signed: string) => rig.post('/v1/graph/expand', expandBody({}, { phone: signed }, ['phone']));
    for (const forged of ['p1.AAAA', 'plain-text', '', `${tokenFields[0]?.[1]}x`, '+1-212-555-0100']) {
      rig.reset();
      expectRefused(await request(signCursor({ ...payload, d: { ...position, [tokenFields[0]?.[0] ?? 'id']: forged } })), forged);
    }
  });
});
