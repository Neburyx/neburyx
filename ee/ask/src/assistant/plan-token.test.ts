import { ASSISTANT_PLAN_MAX_CHARACTERS, ASSISTANT_PLAN_PATTERN } from '@neburyx/contracts';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueChoiceToken, verifyChoiceToken } from './choice-token.js';
import { hashKeys, hashText, issuePlan, readPlan, type Plan, type PlanBinding } from './plan-token.js';

const sign = (text: string): string => createHmac('sha256', 'a-test-key').update(text).digest('hex');
const NOW = 2_000_000;
const BINDING: PlanBinding = { principalId: 'u-1', sourceId: 'demo', investigationId: 'inv-1', definition: 'd'.repeat(64), mask: false };
const PLAN: Plan = { messageHash: hashText('who else?'), viewHash: hashKeys(['n1', 'n2']), fromView: false, steps: [{ tool: 'shared', values: { id: 'A-1' } }], wait: { tool: 'shared-attribute', values: { entityType: 'widget', stableId: 'DEV-884' } }, counters: { steps: 2, rows: 5, calls: 3, elapsedMs: 900 } };

describe('the plan of a confirmation', () => {
  it('is read back as it was made, for exactly what it is bound to', () => {
    const token = issuePlan(sign, BINDING, PLAN, NOW) ?? '';
    expect(ASSISTANT_PLAN_PATTERN.test(token)).toBe(true);
    expect(readPlan(sign, token, BINDING, NOW + 1)).toEqual(PLAN);
  });

  it.each([
    ['another person', { ...BINDING, principalId: 'u-2' }],
    ['another source', { ...BINDING, sourceId: 'other' }],
    ['another investigation', { ...BINDING, investigationId: 'inv-2' }],
    ['another definition of the tool', { ...BINDING, definition: 'e'.repeat(64) }],
    ['another masking', { ...BINDING, mask: true }],
  ])('is refused for %s', (_name, binding) => {
    expect(readPlan(sign, issuePlan(sign, BINDING, PLAN, NOW) ?? '', binding, NOW + 1)).toBeUndefined();
  });

  it('is refused when it has expired, when its expiry was moved, and when any part of it was changed', () => {
    const token = issuePlan(sign, BINDING, PLAN, NOW) ?? '';
    const [expiry = '', payload = '', signature = ''] = token.split('.');
    expect(readPlan(sign, token, BINDING, Number(expiry) + 1)).toBeUndefined();
    expect(readPlan(sign, `${Number(expiry) + 1}.${payload}.${signature}`, BINDING, NOW + 1)).toBeUndefined();
    const other = Buffer.from(JSON.stringify({ ...PLAN, wait: { tool: 'expand', values: {} } }), 'utf8').toString('base64url');
    expect(readPlan(sign, `${expiry}.${other}.${signature}`, BINDING, NOW + 1)).toBeUndefined();
    expect(readPlan(sign, `${expiry}.${payload}.${signature.replace(/.$/, signature.endsWith('0') ? '1' : '0')}`, BINDING, NOW + 1)).toBeUndefined();
    expect(readPlan(sign, 'not a token', BINDING, NOW)).toBeUndefined();
  });

  it('is never valid as a choice token or a continue token, and a choice token is never valid as a plan', () => {
    const plan = issuePlan(sign, BINDING, PLAN, NOW) ?? '';
    const choice = { principalId: 'u-1', sourceId: 'demo', investigationId: 'inv-1', intent: 'shared', definition: 'd'.repeat(64), roles: ['id'], entities: { id: 'A-1' }, mask: false };
    expect(verifyChoiceToken(sign, plan, choice, NOW + 1)).toBe(false);
    expect(readPlan(sign, issueChoiceToken(sign, choice, NOW), BINDING, NOW + 1)).toBeUndefined();
  });

  it('holds the hash of the message and of the view, and no result, element or text of the model', () => {
    const [, payload = ''] = (issuePlan(sign, BINDING, PLAN, NOW) ?? '').split('.');
    const text = Buffer.from(payload, 'base64url').toString('utf8');
    expect(text).not.toContain('who else?');
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['counters', 'fromView', 'messageHash', 'steps', 'viewHash', 'wait']);
    expect(hashKeys(['n2', 'n1'])).toBe(hashKeys(['n1', 'n2']));
  });

  it('stays within the ceiling at the most steps and the longest values, and is not issued past it', () => {
    const long = (n: number) => ({ tool: 't'.repeat(120), values: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`p${i}`, String(n).padEnd(150, 'v')])) });
    const big: Plan = { ...PLAN, steps: Array.from({ length: 4 }, (_, i) => long(i)) };
    const token = issuePlan(sign, BINDING, big, NOW);
    expect(token === undefined || token.length <= ASSISTANT_PLAN_MAX_CHARACTERS).toBe(true);
    const huge: Plan = { ...PLAN, steps: Array.from({ length: 40 }, (_, i) => long(i)) };
    expect(issuePlan(sign, BINDING, huge, NOW)).toBeUndefined();
  });
});
