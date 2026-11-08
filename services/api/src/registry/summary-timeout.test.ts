import { describe, expect, it } from 'vitest';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
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
