import { edgeRefSegmentOf, MAX_EDGE_REF_SEGMENT, type DerivedEdgeRef, type StoredEdgeRef } from '@neburyx/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { closedSetOf, statementProblems } from '../testing/fuzz-closed-set.js';
import { FIELD_NAMES, TEMPLATE_NATIVE, fuzzParams, hostileText } from '../testing/fuzz-corpus.js';
import { FUZZ_SOURCE, allowedNames, startFuzzRig } from '../testing/fuzz-rig.js';

const names = new Set([...allowedNames(), 'widget', 'gadget', 'phone', 'MADE_FROM', 'USES', FUZZ_SOURCE]);
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

const REF: StoredEdgeRef = { sourceId: FUZZ_SOURCE, type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' };
const get = (url: string) => rig.app.inject({ method: 'GET', url });
/** A lone surrogate cannot be sent in a URL, so it is sent as the replacement character, as the other path fuzz does. */
const sendable = (text: string): string => encodeURIComponent(text.replace(/[\ud800-\udfff]/g, '\ufffd'));
const urlOf = (ref: StoredEdgeRef, query = '') => `/v1/edges/${encodeURIComponent(edgeRefSegmentOf(ref))}${query}`;

describe('GET /v1/edges/{ref}', () => {
  it('serves its benign reference, so the refusals below are the mutations and not the reference', async () => {
    rig.reset();
    expect(codeOf((await get(urlOf(REF))).body)).not.toBe('INVALID_REQUEST');
    rig.reset();
  });

  it('answers INVALID_REQUEST and reads nothing for any segment that is not the unpadded base64url text of a stored reference', async () => {
    await fc.assert(
      fc.asyncProperty(hostileText(known), async (segment) => {
        rig.reset();
        const response = await get(`/v1/edges/${sendable(segment)}`);
        expect(response.statusCode).toBe(400);
        expect(codeOf(response.body)).toBe('INVALID_REQUEST');
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(80),
    );
  });

  it('answers INVALID_REQUEST and reads nothing for a reference with a missing, mistyped or extra key', async () => {
    const mutation = fc.record({ key: fc.constantFrom('sourceId', 'type', 'from', 'to', 'stableId'), how: fc.constantFrom('remove', 'retype', 'extra'), extra: hostileText(known) });
    await fc.assert(
      fc.asyncProperty(mutation, async ({ key, how, extra }) => {
        rig.reset();
        const body: Record<string, unknown> = { ...REF };
        if (how === 'remove') delete body[key];
        else if (how === 'retype') body[key] = 7;
        else body[extra] = 'x';
        const segment = Buffer.from(JSON.stringify(body)).toString('base64url');
        const response = await get(`/v1/edges/${segment}`);
        expect(codeOf(response.body)).toBe('INVALID_REQUEST');
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(80),
    );
  });

  it('answers INVALID_REQUEST and reads nothing for a segment one over the bound, and serves one at it', async () => {
    rig.reset();
    expect(codeOf((await get(`/v1/edges/${'a'.repeat(MAX_EDGE_REF_SEGMENT + 1)}`)).body)).toBe('INVALID_REQUEST');
    expect(rig.executor.calls).toEqual([]);
    const long = { ...REF, stableId: 'x'.repeat(1400) };
    expect(edgeRefSegmentOf(long).length).toBeLessThanOrEqual(MAX_EDGE_REF_SEGMENT);
    expect(codeOf((await get(urlOf(long))).body)).not.toBe('INVALID_REQUEST');
    rig.reset();
  });

  it('answers INVALID_REQUEST and reads nothing for any query parameter but mask, and for a mask that is not true or false', async () => {
    await fc.assert(
      fc.asyncProperty(hostileText(known).filter((key) => key !== 'mask' && key !== ''), async (key) => {
        rig.reset();
        const response = await get(urlOf(REF, `?${sendable(key)}=1`));
        expect(codeOf(response.body)).toBe('INVALID_REQUEST');
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(60),
    );
    for (const value of ['yes', '1', 'TRUE', '']) {
      rig.reset();
      expect(codeOf((await get(urlOf(REF, `?mask=${value}`))).body), value).toBe('INVALID_REQUEST');
      expect(rig.executor.calls).toEqual([]);
    }
  });

  it('writes no statement outside the closed set and none that holds a piece of the reference, for any stable ID', async () => {
    await fc.assert(
      fc.asyncProperty(hostileText(known).filter((text) => text !== ''), fc.constantFrom(undefined, 'true', 'false'), async (stableId, mask) => {
        rig.reset();
        const response = await get(urlOf({ ...REF, stableId }, mask === undefined ? '' : `?mask=${mask}`));
        expect(['INVALID_REQUEST', 'NOT_FOUND', undefined]).toContain(codeOf(response.body));
        expect(statementProblems(rig, closed, [stableId].filter((text) => !known.has(text) && text.length >= 4))).toEqual([]);
      }),
      fuzzParams(80),
    );
  });

  it('answers the same NOT_FOUND for a source that is not configured whatever the rest of the reference', async () => {
    await fc.assert(
      fc.asyncProperty(hostileText(known).filter((text) => text !== ''), async (source) => {
        rig.reset();
        const response = await get(urlOf({ ...REF, sourceId: source }));
        expect(codeOf(response.body)).toBe('NOT_FOUND');
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(60),
    );
  });
});

const DERIVED: DerivedEdgeRef = { sourceId: FUZZ_SOURCE, derived: { ruleId: 'shared-gadget', from: { sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-1' }, to: { sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-2' } } };

describe('GET /v1/edges/{ref} for a derived reference', () => {
  it('serves its benign reference, so the refusals below are the mutations and not the reference', async () => {
    rig.reset();
    expect(codeOf((await get(`/v1/edges/${edgeRefSegmentOf(DERIVED)}`)).body)).not.toBe('INVALID_REQUEST');
    rig.reset();
  });

  it('answers INVALID_REQUEST and reads nothing for a reference with a missing, mistyped or extra key at any level', async () => {
    const mutation = fc.record({ level: fc.constantFrom('top', 'derived', 'from', 'to'), key: fc.constantFrom('sourceId', 'derived', 'ruleId', 'from', 'to', 'entityType', 'stableId'), how: fc.constantFrom('remove', 'retype', 'extra'), extra: hostileText(known) });
    await fc.assert(
      fc.asyncProperty(mutation, async ({ level, key, how, extra }) => {
        rig.reset();
        const body = structuredClone(DERIVED) as unknown as Record<string, Record<string, Record<string, unknown>>>;
        const holder = (level === 'top' ? body : level === 'derived' ? body['derived'] : body['derived']?.[level]) as Record<string, unknown> | undefined;
        fc.pre(holder !== undefined && (how === 'extra' || key in holder));
        if (how === 'remove') delete holder?.[key];
        else if (how === 'retype') {
          if (holder !== undefined) holder[key] = 7;
        } else if (holder !== undefined) holder[extra] = 'x';
        const response = await get(`/v1/edges/${Buffer.from(JSON.stringify(body)).toString('base64url')}`);
        expect(codeOf(response.body)).toBe('INVALID_REQUEST');
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(100),
    );
  });

  it('writes no statement outside the closed set and none that holds a piece of the reference, for any stable ID', async () => {
    await fc.assert(
      fc.asyncProperty(hostileText(known).filter((text) => text !== ''), async (stableId) => {
        rig.reset();
        const ref = { ...DERIVED, derived: { ...DERIVED.derived, to: { ...DERIVED.derived.to, stableId } } };
        const response = await get(`/v1/edges/${encodeURIComponent(edgeRefSegmentOf(ref))}`);
        expect(['INVALID_REQUEST', 'NOT_FOUND', undefined]).toContain(codeOf(response.body));
        expect(statementProblems(rig, closed, [stableId].filter((text) => !known.has(text) && text.length >= 4))).toEqual([]);
      }),
      fuzzParams(80),
    );
  });
});
