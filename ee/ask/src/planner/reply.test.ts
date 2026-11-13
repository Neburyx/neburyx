import { describe, expect, it } from 'vitest';
import { MODEL_FAMILIES } from '../refusal/families.js';
import { MODEL_DECLINED, readReply } from './reply.js';

const refusal = (extra: Record<string, unknown>) => JSON.stringify({ kind: 'unsupported', ...extra });
const other = { ok: true, plan: { kind: 'unsupported', family: 'other', reason: MODEL_DECLINED } };

describe('the reading of a refusal of the model', () => {
  it.each(MODEL_FAMILIES)('keeps the family %s that the model names, and never its reason', (family) => {
    expect(readReply(refusal({ family, reason: 'own words' }))).toEqual({ ok: true, plan: { kind: 'unsupported', family, reason: MODEL_DECLINED } });
  });

  it.each([
    ['no family', { reason: 'x' }],
    ['an unknown family', { family: 'made-up', reason: 'x' }],
    ['a server-only family', { family: 'model-refused', reason: 'x' }],
    ['a family that is not a string', { family: 4, reason: 'x' }],
    ['no reason', { family: 'path' }],
    ['a reason over 500 characters', { family: 'path', reason: 'x'.repeat(600) }],
    ['an extra key', { family: 'path', reason: 'x', extra: 1 }],
  ])('reads %s as a refusal of the family other', (_name, extra) => {
    expect(readReply(refusal(extra))).toEqual(other);
  });

  it('keeps the strict reading for everything that is not an unsupported object', () => {
    expect(readReply('not json').ok).toBe(false);
    expect(readReply(JSON.stringify({ kind: 'plan', templateId: 'nope' })).ok).toBe(false);
    expect(readReply(JSON.stringify({ kind: 'other' })).ok).toBe(false);
  });
});
