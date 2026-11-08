import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { closedSetOf, statementProblems, tokensOf } from '../testing/fuzz-closed-set.js';
import { FIELD_NAMES, TEMPLATE_NATIVE, fuzzParams, hostileText, textLeaves } from '../testing/fuzz-corpus.js';
import { FUZZ_SOURCE, FUZZ_TEXT, allowedNames, startFuzzRig } from '../testing/fuzz-rig.js';
import { TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { makeToken } from '../reference/token.js';
import { decodeStored, encodeStored } from '../reference/stored-text.js';

const names = new Set([...allowedNames(), 'widget', 'gadget', 'phone', 'holder', FUZZ_SOURCE]);
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

const PHONE = '+1-212-555-0100';
const tokenFor = (value: string, place: { sourceId?: string; entityType?: string } = {}) => makeToken(TEST_REFERENCE_KEYS, { sourceId: place.sourceId ?? FUZZ_SOURCE, entityType: place.entityType ?? 'phone' }, value);

const base64url = fc.string({ unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'), maxLength: 90 });
const good = tokenFor(PHONE);
const forged = fc
  .oneof(
  base64url.map((text) => `p1.${text}`),
  fc.nat(good.length).map((cut) => good.slice(0, cut)),
  base64url.map((text) => good + text),
  fc.nat(good.length - 4).map((position) => `${good.slice(0, position + 3)}${good[position + 3] === 'A' ? 'B' : 'A'}${good.slice(position + 4)}`),
  fc.constant(`${good}=`),
  fc.constant('p1.'),
  fc.constant(`p2.${good.slice(3)}`),
  fc.constant(tokenFor('+1-212-555-0199').toUpperCase()),
  fc.constantFrom('+1-212-555-0100', 'plain', 'p1', 'P1.AAAA'),
  hostileText(known),
  fc.constant(`p1.${'A'.repeat(266_700)}`),
  )
  .filter((text) => text !== good);

type Send = (stableId: string) => Promise<{ readonly body: string }>;
const refPositions: readonly (readonly [string, Send])[] = [
  ['expand ref', (stableId) => rig.post('/v1/graph/expand', { sourceId: FUZZ_SOURCE, ref: { entityType: 'phone', stableId }, neighborTypes: ['widget'] })],
  ['degree preview ref', (stableId) => rig.post('/v1/graph/preview-expansion', { sourceId: FUZZ_SOURCE, ref: { entityType: 'phone', stableId } })],
  ['lookup ref', (stableId) => rig.post('/v1/entities/lookup', { sourceId: FUZZ_SOURCE, ref: { entityType: 'phone', stableId } })],
  ['entity path', async (stableId) => ({ body: (await rig.app.inject({ method: 'GET', url: `/v1/entities/${FUZZ_SOURCE}/phone/${encodeURIComponent(stableId.replace(/[\ud800-\udfff]/g, '\ufffd'))}` })).body })],
];

describe('a forged stable ID of a keyed entity type', () => {
  for (const [name, send] of refPositions) {
    it(`${name}: is INVALID_REQUEST and reads nothing`, async () => {
      await fc.assert(
        fc.asyncProperty(forged, async (stableId) => {
          rig.reset();
          const response = await send(stableId);
          expect(codeOf(response.body)).toBe('INVALID_REQUEST');
          expect(rig.executor.calls).toEqual([]);
        }),
        fuzzParams(120),
      );
    });
  }

  it('exactRefs of search more: is INVALID_REQUEST before any executor call, including when the related page has no records', async () => {
    await fc.assert(
      fc.asyncProperty(forged, async (stableId) => {
        rig.reset();
        const response = await rig.post('/v1/search/entities/more', { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, group: 'related', cursor: 'v1.x.y', exactRefs: [{ sourceId: FUZZ_SOURCE, entityType: 'phone', stableId }] });
        expect(codeOf(response.body)).toBe('INVALID_REQUEST');
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(120),
    );
  });

  it('a valid token made for another source or another entity type is refused in every position', async () => {
    const wrong = [tokenFor(PHONE, { sourceId: 'other' }), tokenFor(PHONE, { entityType: 'holder' }), tokenFor(PHONE, { entityType: 'widget' })];
    for (const stableId of wrong) {
      for (const [name, send] of refPositions) {
        rig.reset();
        expect(codeOf((await send(stableId)).body), name).toBe('INVALID_REQUEST');
        expect(rig.executor.calls, name).toEqual([]);
      }
      rig.reset();
      const response = await rig.post('/v1/search/entities/more', { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, group: 'related', cursor: 'v1.x.y', exactRefs: [{ sourceId: FUZZ_SOURCE, entityType: 'phone', stableId }] });
      expect(codeOf(response.body)).toBe('INVALID_REQUEST');
      expect(rig.executor.calls).toEqual([]);
    }
  });

  it('a plain stable ID of a type that is not keyed is not read as a token', async () => {
    rig.reset();
    const response = await rig.post('/v1/graph/preview-expansion', { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: good } });
    expect(codeOf(response.body)).not.toBe('INVALID_REQUEST');
    expect(rig.executor.calls.find((call) => call.templateId.startsWith('degree-preview'))?.parameters['stableId']).toBe(good);
  });
});

async function relatedCursor(): Promise<string> {
  const first = await rig.post('/v1/search/entities', { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT });
  const cursor = (JSON.parse(first.body) as { related: { nextCursor?: string } }).related.nextCursor;
  if (cursor === undefined) throw new Error('the related group has no next page');
  return cursor;
}

describe('a valid token', () => {
  it('is decoded by the gate: the raw value is in parameters and never in the statement', async () => {
    const sends: readonly [string, () => Promise<{ readonly body: string; readonly statusCode: number }>][] = [
      ['degree preview', () => rig.post('/v1/graph/preview-expansion', { sourceId: FUZZ_SOURCE, ref: { entityType: 'phone', stableId: good } })],
      ['lookup', () => rig.post('/v1/entities/lookup', { sourceId: FUZZ_SOURCE, ref: { entityType: 'phone', stableId: good } })],
      ['entity path', () => rig.app.inject({ method: 'GET', url: `/v1/entities/${FUZZ_SOURCE}/phone/${encodeURIComponent(good)}` })],
      ['exactRefs', async () => rig.post('/v1/search/entities/more', { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, group: 'related', cursor: await relatedCursor(), exactRefs: [{ sourceId: FUZZ_SOURCE, entityType: 'phone', stableId: good }] })],
    ];
    for (const [name, send] of sends) {
      rig.reset();
      const response = await send();
      expect(response.statusCode, name).toBe(name === 'degree preview' ? 404 : 200);
      if (name !== 'exactRefs') expect(rig.executor.calls.some((call) => call.parameters['stableId'] === PHONE), name).toBe(true);
      expect(statementProblems(rig, closed, [PHONE]), name).toEqual([]);
      if (name === 'exactRefs') expect(rig.executor.calls.some((call) => call.templateId === 'entity-related-context' && JSON.stringify(call.parameters).includes(PHONE)), 'the related-context read holds the decoded value as a parameter').toBe(true);
    }
  });

  it('comes out of an expansion as a token that reads back, and the raw value is nowhere in the answer', async () => {
    rig.reset();
    const response = await rig.post('/v1/graph/expand', { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes: ['phone'], limit: 2 });
    expect(response.statusCode).toBe(200);
    const tokens = tokensOf(JSON.parse(response.body));
    expect(tokens.length).toBeGreaterThan(0);
    for (const node of (JSON.parse(response.body) as { nodes: { ref: { entityType: string; stableId: string } }[] }).nodes.filter((entry) => entry.ref.entityType === 'phone')) expect(node.ref.stableId).toMatch(/^p1\./);
    for (const token of tokens) {
      rig.reset();
      expect(codeOf((await rig.post('/v1/graph/preview-expansion', { sourceId: FUZZ_SOURCE, ref: token })).body)).not.toBe('INVALID_REQUEST');
    }
  });
});

describe('lookup by value', () => {
  it('refuses a keyed type while masked, whatever the value, and reads nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(hostileText(known), fc.constant(good), fc.constant(PHONE)), fc.constantFrom('phone', 'holder'), fc.constant(true), async (value, entityType, mask) => {
        rig.reset();
        const response = await rig.post('/v1/entities/lookup', { sourceId: FUZZ_SOURCE, value: { entityType, value }, mask });
        expect(codeOf(response.body)).toBe('INVALID_REQUEST');
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(80),
    );
  });

  it('unmasked, makes a token of any value, a token-looking one included, and the value reaches the executor only as a parameter', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(hostileText(known).filter((text) => text !== ''), fc.constant(good), fc.constant(PHONE)), async (value) => {
        rig.reset();
        const response = await rig.post('/v1/entities/lookup', { sourceId: FUZZ_SOURCE, value: { entityType: 'phone', value }, mask: false });
        expect(codeOf(response.body)).not.toBe('INVALID_REQUEST');
        expect(statementProblems(rig, closed, textLeaves({ value }, known))).toEqual([]);
        expect(rig.executor.calls.some((call) => call.parameters['stableId'] === value)).toBe(true);
      }),
      fuzzParams(100),
    );
  });

  it('passes the value of a type that is not keyed on as it is', async () => {
    rig.reset();
    await rig.post('/v1/entities/lookup', { sourceId: FUZZ_SOURCE, value: { entityType: 'widget', value: good } });
    expect(rig.executor.calls.find((call) => call.templateId === 'entity-load')?.parameters['stableId']).toBe(good);
  });
});

describe('the stored-ID encoding', () => {
  const ids = fc.oneof(fc.string({ unit: 'binary' }), hostileText(known), fc.constantFrom('', '\0', '~e1:', '~e1:AAAA', '\ud800', 'a\0b'), fc.string({ maxLength: 20 }).map((text) => `~e1:${text}`));

  it('gives back every ID exactly', () => {
    fc.assert(
      fc.property(ids, (id) => decodeStored(encodeStored(id)) === id),
      fuzzParams(500),
    );
  });

  it('leaves a forged or non-canonical text that starts with the marker as the ID it is', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (tail) => {
        const text = `~e1:${tail}`;
        const decoded = decodeStored(text);
        return decoded === text || encodeStored(decoded) === text;
      }),
      fuzzParams(500),
    );
  });

  it('refuses such a text as the stable ID of a keyed type, by the token check', async () => {
    for (const forgedText of ['~e1:AAAA', encodeStored('\0'), encodeStored('\ud800'), `~e1:${good}`]) {
      rig.reset();
      const response = await rig.post('/v1/graph/preview-expansion', { sourceId: FUZZ_SOURCE, ref: { entityType: 'phone', stableId: forgedText } });
      expect(codeOf(response.body)).toBe('INVALID_REQUEST');
      expect(rig.executor.calls).toEqual([]);
    }
  });
});
