import { describe, expect, it } from 'vitest';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { BUDGET_DEFAULTS } from '../mapping/budgets.js';
import { summariesOf } from './summary.js';

const row = (id: string) => ({ id, alias: id, state: 'connected' as const, stateReason: null, synthetic: false, lastTestAt: null });

describe('the timeout of the source summary', () => {
  it('is the source\'s own timeout_ms in milliseconds', () => {
    const mapping = mappingOf(sourceWith('alpha', { budgets: { timeout_ms: 7000 } }), sourceWith('beta', {}));
    const [alpha, beta] = summariesOf([row('alpha'), row('beta')], mapping);
    expect(alpha?.timeoutMs).toBe(7000);
    expect(beta?.timeoutMs).toBe(5000);
  });
});

describe('the step limit of the source summary', () => {
  it('is the source\'s max_hops, and the gate\'s default when the mapping sets none', () => {
    const mapping = mappingOf(sourceWith('alpha', { budgets: { max_hops: 3 } }), sourceWith('beta', {}));
    const [alpha, beta] = summariesOf([row('alpha'), row('beta')], mapping);
    expect(alpha?.maxHops).toBe(3);
    expect(beta?.maxHops).toBe(BUDGET_DEFAULTS.maxHops);
  });
});
