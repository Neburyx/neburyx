import { describe, expect, it } from 'vitest';
import { MODEL_FAMILIES } from '../refusal/families.js';
import { MAX_FAILED_STARTS, MAX_SCANNED_REPLY, MODEL_DECLINED, readReply } from './reply.js';

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

const PLAN = { kind: 'plan', templateId: 'entity', templateVersion: 1, params: { ref: { entityType: 'widget', stableId: '‹widget#1›' } }, rationale: 'It names one.' };
const PLAN_TEXT = JSON.stringify(PLAN);
const planOf = (reply: string) => readReply(reply);
const PLAIN = { ok: true, plan: PLAN };
const REFUSED = { ok: false, problems: ['reply: not one JSON object'] };

describe('the object among prose', () => {
  it.each([
    ['prose before the object', `The problem is probably the version, so here it is. ${PLAN_TEXT}`],
    ['prose after the object', `${PLAN_TEXT} I hope that helps.`],
    ['prose before and after', `Here is my answer: ${PLAN_TEXT}\nLet me know.`],
    ['prose before one fenced block', `Likely issue: the version.\n\`\`\`json\n${PLAN_TEXT}\n\`\`\``],
    ['prose inside a fence, with one object', `\`\`\`json\nHere it is: ${PLAN_TEXT}\n\`\`\``],
    ['a fence in the middle of prose', `Answer:\n\`\`\`\n${PLAN_TEXT}\n\`\`\`\nDone.`],
  ])('reads the plan from %s', (_name, reply) => {
    expect(planOf(reply)).toEqual(PLAIN);
  });

  it('keeps the whole-reply readings: an object alone and one fenced block', () => {
    expect(planOf(PLAN_TEXT)).toEqual(PLAIN);
    expect(planOf(`\`\`\`json\n${PLAN_TEXT}\n\`\`\``)).toEqual(PLAIN);
  });

  it.each([
    ['no object at all', 'I cannot help with that.'],
    ['two different objects', `Not this: {"kind":"unsupported"} but this: ${PLAN_TEXT}`],
    ['the same object twice', `${PLAN_TEXT} and again ${PLAN_TEXT}`],
    ['an unclosed fence around prose', '```json\nno object here\n```'],
  ])('refuses %s as not one JSON object', (_name, reply) => {
    expect(planOf(reply)).toEqual(REFUSED);
  });

  it('does not coerce: a version written as text stays invalid, with or without prose', () => {
    const asText = JSON.stringify({ ...PLAN, templateVersion: '1' });
    const bare = planOf(asText);
    expect(bare.ok).toBe(false);
    expect(planOf(`Sure. ${asText}`)).toEqual(bare);
  });

  it('counts nested objects as parts of the one top-level object, and braces inside a string do not split it', () => {
    const tricky = JSON.stringify({ ...PLAN, rationale: 'braces } and { and "quotes" inside' });
    expect(planOf(`Prose. ${tricky}`)).toMatchObject({ ok: true });
  });

  it('ignores an unbalanced brace and a balanced span that is not JSON in the prose, and quotes and apostrophes outside a candidate', () => {
    expect(planOf(`He said "it's { ok" and {like this} and then ${PLAN_TEXT}`)).toEqual(PLAIN);
    expect(planOf(`A stray { here, then ${PLAN_TEXT}`)).toEqual(PLAIN);
  });

  it('does not scan a reply that is JSON as a whole but not an object: an array holding a plan, a string holding a plan', () => {
    expect(planOf(`[${PLAN_TEXT}]`)).toEqual({ ok: false, problems: ['reply: not a JSON object'] });
    expect(planOf(JSON.stringify(PLAN_TEXT))).toEqual({ ok: false, problems: ['reply: not a JSON object'] });
  });

  it('reads a refusal after prose as a refusal of the family it names, and never keeps its text', () => {
    expect(planOf(`I would decline. ${refusal({ family: 'judgement', reason: 'secret words' })}`)).toEqual({ ok: true, plan: { kind: 'unsupported', family: 'judgement', reason: MODEL_DECLINED } });
  });

  it('is bounded: the most failed starts then one object is read, one more is refused, and a reply above the cap is refused, all quickly', () => {
    const started = Date.now();
    expect(planOf(`${'{ '.repeat(MAX_FAILED_STARTS)}${PLAN_TEXT}`)).toEqual(PLAIN);
    expect(planOf(`${'{ '.repeat(MAX_FAILED_STARTS + 1)}${PLAN_TEXT}`)).toEqual(REFUSED);
    expect(planOf(`${'{"'.repeat(20_000)}${PLAN_TEXT}`)).toEqual(REFUSED);
    expect(planOf(`${'x'.repeat(MAX_SCANNED_REPLY)} ${PLAN_TEXT}`)).toEqual(REFUSED);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
