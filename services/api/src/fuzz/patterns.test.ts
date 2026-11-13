import fc from 'fast-check';
import { patternPreviewResponseSchema, patternValidateResponseSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { closedSetOf, statementProblems } from '../testing/fuzz-closed-set.js';
import { FIELD_NAMES, TEMPLATE_NATIVE, fuzzParams, hostileText, textLeaves, wrongType } from '../testing/fuzz-corpus.js';
import { FUZZ_SOURCE, allowedNames, startFuzzRig } from '../testing/fuzz-rig.js';

const rig = await startFuzzRig();
const closed = await closedSetOf(rig);
const known = new Set([...allowedNames(), ...FIELD_NAMES, ...TEMPLATE_NATIVE, 'widget', 'gadget', 'phone', 'holder', 'MADE_FROM', 'USES', FUZZ_SOURCE]);
const hostile = hostileText(known).filter((text) => text !== '');

const codeOf = (body: string): string | undefined => {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
};
const ROUTES = [
  ['POST /v1/patterns/validate', '/v1/patterns/validate', patternValidateResponseSchema],
  ['POST /v1/patterns/preview', '/v1/patterns/preview', patternPreviewResponseSchema],
] as const;

describe.each(ROUTES)('a hostile definition sent to %s', (_name, url, schema) => {
  const validate = (body: unknown) => rig.post(url, body);
  it('is answered with problems that hold none of its text, and reads nothing from the source, whatever the text is and wherever it is put', async () => {
    const placed = fc.tuple(hostile, fc.constantFrom('anchorType', 'relationshipTypes', 'arrivesAt', 'direction', 'property', 'key', 'value', 'window', 'op'));
    await fc.assert(
      fc.asyncProperty(placed, async ([text, where]) => {
        rig.reset();
        const condition = { op: where === 'op' ? text : 'eq', on: 'neighbor', property: where === 'property' ? text : 'nickname', value: { kind: 'text', value: where === 'value' ? text : 'a' } };
        const step = {
          relationshipTypes: [where === 'relationshipTypes' ? text : 'MADE_FROM'],
          direction: where === 'direction' ? text : 'out',
          arrivesAt: where === 'arrivesAt' ? text : 'gadget',
          conditions: [condition],
          ...(where === 'window' ? { window: { from: text, to: text } } : {}),
          ...(where === 'key' ? { [text]: 1 } : {}),
        };
        const response = await validate({ sourceId: FUZZ_SOURCE, definition: { anchorType: where === 'anchorType' ? text : 'widget', steps: [step] } });
        expect(response.statusCode).toBe(200);
        const answer = schema.parse(JSON.parse(response.body));
        expect(answer.status).toBe('invalid');
        for (const piece of [text].filter((candidate) => candidate.length >= 4)) expect(response.body).not.toContain(piece);
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(120),
    );
  });

  it('is answered, whatever the JSON it is, as a valid or an invalid pattern with a path of keys and indices, or refused as a bad request, and the source is never read', async () => {
    const json: fc.Arbitrary<unknown> = fc.letrec((tie) => ({ value: fc.oneof({ depthSize: 'small' }, fc.string({ maxLength: 12 }), fc.integer(), fc.boolean(), fc.constant(null), fc.array(tie('value'), { maxLength: 4 }), fc.dictionary(fc.constantFrom('anchorType', 'steps', 'relationshipTypes', 'direction', 'arrivesAt', 'conditions', 'window', 'op', 'on', 'property', 'value', 'values', 'kind', 'days', 'from', 'to'), tie('value'), { maxKeys: 5 })) })).value;
    await fc.assert(
      fc.asyncProperty(json, fc.option(wrongType, { nil: undefined }), async (definition, mask) => {
        rig.reset();
        const response = await validate({ sourceId: FUZZ_SOURCE, definition, ...(mask === undefined ? {} : { mask }) });
        if (response.statusCode === 200) {
          const answer = schema.parse(JSON.parse(response.body));
          if (answer.status === 'invalid') for (const problem of answer.problems) expect(problem.path.every((key) => typeof key === 'string' || Number.isInteger(key))).toBe(true);
        } else {
          expect(codeOf(response.body)).toBe('INVALID_REQUEST');
        }
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(150),
    );
  });
});

describe.each(ROUTES)('the envelope of %s', (_name, url) => {
  const validate = (body: unknown) => rig.post(url, body);
  it('answers NOT_FOUND for a source that is not in the mapping, whatever the text, and nothing is read', async () => {
    await fc.assert(
      fc.asyncProperty(hostile, async (sourceId) => {
        rig.reset();
        const response = await validate({ sourceId, definition: {} });
        expect(codeOf(response.body)).toBe('NOT_FOUND');
        expect(rig.executor.calls).toEqual([]);
        if (sourceId.length >= 4) expect(response.body).not.toContain(sourceId);
      }),
      fuzzParams(60),
    );
  });

  it('answers INVALID_REQUEST for a missing, extra or mistyped member and a definition that is not an object, and nothing is read', async () => {
    const mutated = fc.tuple(fc.constantFrom('remove', 'retype', 'extra'), fc.constantFrom('sourceId', 'definition', 'mask'), wrongType.filter((value) => typeof value !== 'boolean'), hostile);
    await fc.assert(
      fc.asyncProperty(mutated, async ([how, member, wrong, key]) => {
        if (how === 'remove' && member === 'mask') return;
        rig.reset();
        const body: Record<string, unknown> = { sourceId: FUZZ_SOURCE, definition: {}, mask: true };
        if (how === 'remove') delete body[member];
        else if (how === 'retype') body[member] = member === 'definition' && typeof wrong === 'object' && wrong !== null && !Array.isArray(wrong) ? [wrong] : wrong;
        else body[key] = 'x';
        const response = await validate(body);
        expect(response.statusCode).toBe(400);
        expect(codeOf(response.body)).toBe('INVALID_REQUEST');
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(80),
    );
  });

  it('answers INVALID_REQUEST for malformed JSON and a body over 1 MiB, and UNSUPPORTED_MEDIA_TYPE for a content type that is not JSON, and nothing is read', async () => {
    rig.reset();
    const inject = (payload: string, contentType = 'application/json') => rig.app.inject({ method: 'POST', url, payload, headers: { 'content-type': contentType } });
    expect(codeOf((await inject('{"sourceId": "demo", "definition"')).body)).toBe('INVALID_REQUEST');
    expect(codeOf((await inject(JSON.stringify({ sourceId: FUZZ_SOURCE, definition: { anchorType: 'a'.repeat(1_100_000) } }))).body)).toBe('INVALID_REQUEST');
    expect(codeOf((await inject(JSON.stringify({ sourceId: FUZZ_SOURCE, definition: {} }), 'application/xml')).body)).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(rig.executor.calls).toEqual([]);
  });
});

describe('a hostile definition sent to POST /v1/patterns/run', () => {
  const run = (body: unknown) => rig.post('/v1/patterns/run', body);
  const anchor = { entityType: 'widget', stableId: 'W-1' };

  it('is refused with INVALID_REQUEST, with none of its text in the answer, and reads nothing from the source, whatever the text is and wherever it is put', async () => {
    const placed = fc.tuple(hostile, fc.constantFrom('anchorType', 'relationshipTypes', 'arrivesAt', 'direction', 'property', 'key', 'window', 'op'));
    await fc.assert(
      fc.asyncProperty(placed, async ([text, where]) => {
        rig.reset();
        const condition = { op: where === 'op' ? text : 'eq', on: 'neighbor', property: where === 'property' ? text : 'nickname', value: { kind: 'text', value: 'a' } };
        const step = {
          relationshipTypes: [where === 'relationshipTypes' ? text : 'MADE_FROM'],
          direction: where === 'direction' ? text : 'out',
          arrivesAt: where === 'arrivesAt' ? text : 'gadget',
          conditions: [condition],
          ...(where === 'window' ? { window: { from: text, to: text } } : {}),
          ...(where === 'key' ? { [text]: 1 } : {}),
        };
        const response = await run({ sourceId: FUZZ_SOURCE, definition: { anchorType: where === 'anchorType' ? text : 'widget', steps: [step] }, anchor });
        expect(response.statusCode).toBe(400);
        expect(codeOf(response.body)).toBe('INVALID_REQUEST');
        for (const piece of [text].filter((candidate) => candidate.length >= 4)) expect(response.body).not.toContain(piece);
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(120),
    );
  });

  it('serves hostile text as the value of an accepted condition, and the text reaches the executor as a parameter only, never in a statement', async () => {
    const seen = { served: 0 };
    await fc.assert(
      fc.asyncProperty(hostile, async (raw) => {
        const text = [...raw].slice(0, 200).join('');
        const body = { sourceId: FUZZ_SOURCE, definition: { anchorType: 'widget', steps: [{ relationshipTypes: ['MADE_FROM'], direction: 'out', arrivesAt: 'gadget', conditions: [{ on: 'neighbor', property: 'tier', op: 'eq', value: { kind: 'text', value: text } }] }] }, anchor };
        rig.reset();
        const response = await run(body);
        expect(codeOf(response.body)).not.toBe('INVALID_REQUEST');
        expect(statementProblems(rig, closed, textLeaves(body, new Set([...known, 'steps', 'conditions'])))).toEqual([]);
        if (response.statusCode === 200) {
          seen.served += 1;
          expect(rig.executor.calls.some((call) => JSON.stringify(call.parameters).includes(JSON.stringify(text).slice(1, -1)))).toBe(true);
        }
      }),
      fuzzParams(120),
    );
    expect(seen.served).toBeGreaterThan(0);
  });

  it('answers NOT_FOUND for a source that is not in the mapping, whatever the text, and an anchor of another type than the definition is INVALID_REQUEST, nothing read', async () => {
    await fc.assert(
      fc.asyncProperty(hostile, async (sourceId) => {
        rig.reset();
        const response = await run({ sourceId, definition: { anchorType: 'widget', steps: [] }, anchor });
        expect(codeOf(response.body)).toBe('NOT_FOUND');
        expect(rig.executor.calls).toEqual([]);
        if (sourceId.length >= 4) expect(response.body).not.toContain(sourceId);
      }),
      fuzzParams(60),
    );
    rig.reset();
    expect(codeOf((await run({ sourceId: FUZZ_SOURCE, definition: { anchorType: 'widget', steps: [] }, anchor: { entityType: 'gadget', stableId: 'GD-0' } })).body)).toBe('INVALID_REQUEST');
    expect(rig.executor.calls).toEqual([]);
  });

  it('answers INVALID_REQUEST for a missing, extra or mistyped member and a definition that is not an object, and nothing is read', async () => {
    const mutated = fc.tuple(fc.constantFrom('remove', 'retype', 'extra'), fc.constantFrom('sourceId', 'definition', 'anchor', 'limit', 'mask', 'continue'), wrongType.filter((value) => typeof value !== 'boolean'), hostile);
    await fc.assert(
      fc.asyncProperty(mutated, async ([how, member, wrong, key]) => {
        if (how === 'remove' && ['limit', 'mask', 'continue'].includes(member)) return;
        rig.reset();
        const body: Record<string, unknown> = { sourceId: FUZZ_SOURCE, definition: {}, anchor, limit: 5, mask: true, continue: false };
        if (how === 'remove') delete body[member];
        else if (how === 'retype') body[member] = member === 'definition' && typeof wrong === 'object' && wrong !== null && !Array.isArray(wrong) ? [wrong] : wrong;
        else body[key] = 'x';
        const response = await run(body);
        expect(response.statusCode).toBe(400);
        expect(codeOf(response.body)).toBe('INVALID_REQUEST');
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(80),
    );
  });

  it('answers INVALID_REQUEST for malformed JSON, a body over 1 MiB and a missing key, and UNSUPPORTED_MEDIA_TYPE for a content type that is not JSON, and nothing is read', async () => {
    rig.reset();
    const headers = { 'content-type': 'application/json', 'idempotency-key': 'fuzz-run-key-of-sixteen' };
    const inject = (payload: string, over: Record<string, string> = headers) => rig.app.inject({ method: 'POST', url: '/v1/patterns/run', payload, headers: over });
    expect(codeOf((await inject('{"sourceId": "demo", "definition"')).body)).toBe('INVALID_REQUEST');
    expect(codeOf((await inject(JSON.stringify({ sourceId: FUZZ_SOURCE, definition: { anchorType: 'a'.repeat(1_100_000) }, anchor }))).body)).toBe('INVALID_REQUEST');
    expect(codeOf((await inject(JSON.stringify({ sourceId: FUZZ_SOURCE, definition: {}, anchor }), { 'content-type': 'application/json' })).body)).toBe('INVALID_REQUEST');
    expect(codeOf((await inject(JSON.stringify({ sourceId: FUZZ_SOURCE, definition: {}, anchor }), { ...headers, 'content-type': 'application/xml' })).body)).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(rig.executor.calls).toEqual([]);
  });
});

describe('a hostile request sent to POST /v1/patterns/{id}/run', () => {
  const runSaved = (id: string, body: unknown) => rig.post(`/v1/patterns/${encodeURIComponent(id)}/run`, body);
  const anchor = { entityType: 'widget', stableId: 'W-1' };
  const savedId = async (): Promise<string> => {
    const made = await rig.app.inject({ method: 'POST', url: '/v1/patterns', payload: JSON.stringify({ sourceId: FUZZ_SOURCE, name: 'A saved pattern', kind: 'definition', definition: { anchorType: 'widget', steps: [{ relationshipTypes: ['MADE_FROM'], direction: 'out', arrivesAt: 'gadget' }] } }), headers: { 'content-type': 'application/json' } });
    return (JSON.parse(made.body) as { id: string }).id;
  };

  it('answers NOT_FOUND for an id of any text, a very long one and a mapping preset’s id, with none of the text in the answer, and reads nothing', async () => {
    await fc.assert(
      fc.asyncProperty(hostile, async (id) => {
        rig.reset();
        const response = await runSaved([...id].slice(0, 60).join('').replace(/[\ud800-\udfff]/g, '?'), { anchor });
        expect(codeOf(response.body)).toBe('NOT_FOUND');
        if (id.length >= 4) expect(response.body).not.toContain(id);
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(60),
    );
    rig.reset();
    for (const id of ['a'.repeat(5000), 'linked-gadgets', 'shared-gadgets']) {
      const response = await runSaved(id, { anchor });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('a'.repeat(100));
    }
    expect(rig.executor.calls).toEqual([]);
  });

  it('refuses hostile text as the type of the entity, and serves it as the stable ID of a type that is not keyed, the text reaching the executor as a parameter only', async () => {
    const id = await savedId();
    await fc.assert(
      fc.asyncProperty(hostile, async (raw) => {
        const text = [...raw].slice(0, 200).join('');
        rig.reset();
        const typed = await runSaved(id, { anchor: { entityType: text, stableId: 'W-1' } });
        expect(codeOf(typed.body)).toBe('INVALID_REQUEST');
        expect(rig.executor.calls).toEqual([]);
        const body = { anchor: { entityType: 'widget', stableId: text } };
        const served = await runSaved(id, body);
        expect(codeOf(served.body)).not.toBe('INVALID_REQUEST');
        expect(statementProblems(rig, closed, textLeaves(body, new Set([...known, 'steps', 'conditions'])))).toEqual([]);
      }),
      fuzzParams(80),
    );
  });

  it('answers INVALID_REQUEST for a missing, extra or mistyped member and for a missing key, and nothing is read', async () => {
    const id = await savedId();
    const mutated = fc.tuple(fc.constantFrom('retype', 'extra'), fc.constantFrom('anchor', 'limit', 'mask', 'continue'), wrongType.filter((value) => typeof value !== 'boolean'), hostile);
    await fc.assert(
      fc.asyncProperty(mutated, async ([how, member, wrong, key]) => {
        if (how === 'retype' && ((member === 'limit' && typeof wrong === 'number' && Number.isInteger(wrong) && wrong >= 1) || (member === 'anchor' && typeof wrong === 'object' && wrong !== null && !Array.isArray(wrong) && 'entityType' in wrong))) return;
        rig.reset();
        const body: Record<string, unknown> = { anchor, limit: 5, mask: true, continue: false };
        if (how === 'retype') body[member] = wrong;
        else body[key] = 'x';
        const response = await runSaved(id, body);
        expect(response.statusCode).toBe(400);
        expect(codeOf(response.body)).toBe('INVALID_REQUEST');
        expect(rig.executor.calls).toEqual([]);
      }),
      fuzzParams(80),
    );
    rig.reset();
    const tooLong = await runSaved(id, { anchor: { entityType: 'widget', stableId: 'x'.repeat(1_100_000) } });
    expect(codeOf(tooLong.body)).toBe('INVALID_REQUEST');
    expect(rig.executor.calls).toEqual([]);
    const noKey = await rig.app.inject({ method: 'POST', url: `/v1/patterns/${id}/run`, payload: JSON.stringify({ anchor }), headers: { 'content-type': 'application/json' } });
    expect(codeOf(noKey.body)).toBe('INVALID_REQUEST');
    expect(rig.executor.calls).toEqual([]);
  });
});
