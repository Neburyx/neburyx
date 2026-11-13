import fc from 'fast-check';
import { patternValidateResponseSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { FIELD_NAMES, TEMPLATE_NATIVE, fuzzParams, hostileText, wrongType } from '../testing/fuzz-corpus.js';
import { FUZZ_SOURCE, allowedNames, startFuzzRig } from '../testing/fuzz-rig.js';

const rig = await startFuzzRig();
const known = new Set([...allowedNames(), ...FIELD_NAMES, ...TEMPLATE_NATIVE, 'widget', 'gadget', 'phone', 'holder', 'MADE_FROM', 'USES', FUZZ_SOURCE]);
const hostile = hostileText(known).filter((text) => text !== '');

const codeOf = (body: string): string | undefined => {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
};
const validate = (body: unknown) => rig.post('/v1/patterns/validate', body);

describe('a hostile definition sent to POST /v1/patterns/validate', () => {
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
        const answer = patternValidateResponseSchema.parse(JSON.parse(response.body));
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
          const answer = patternValidateResponseSchema.parse(JSON.parse(response.body));
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

describe('the envelope of POST /v1/patterns/validate', () => {
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
    const inject = (payload: string, contentType = 'application/json') => rig.app.inject({ method: 'POST', url: '/v1/patterns/validate', payload, headers: { 'content-type': contentType } });
    expect(codeOf((await inject('{"sourceId": "demo", "definition"')).body)).toBe('INVALID_REQUEST');
    expect(codeOf((await inject(JSON.stringify({ sourceId: FUZZ_SOURCE, definition: { anchorType: 'a'.repeat(1_100_000) } }))).body)).toBe('INVALID_REQUEST');
    expect(codeOf((await inject(JSON.stringify({ sourceId: FUZZ_SOURCE, definition: {} }), 'application/xml')).body)).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(rig.executor.calls).toEqual([]);
  });
});
