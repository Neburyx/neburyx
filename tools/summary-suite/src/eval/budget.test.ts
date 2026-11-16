import type { ModelProvider } from '@neburyx/ee-ask';
import { describe, expect, it } from 'vitest';
import { realHooks } from '../testing/eval-hooks.js';
import { cli } from '../testing/harness.js';
import type { EvalHooks } from './hooks.js';

const VERDICT = JSON.stringify({ sentences: [{ text: 'This is evidence of fraud.', cites: ['n1'] }] });

/** Hooks whose scripted provider answers the views that hold the account AC-2000 (two of them) with a reply that holds a verdict, which earns every further call the click may make. */
function verdictOnRing(attempts: { count: number }): EvalHooks<ModelProvider> {
  return {
    ...realHooks,
    scriptedProvider: (replyFor) =>
      realHooks.scriptedProvider((values) => {
        attempts.count += 1;
        return values.includes('AC-2000') ? VERDICT : replyFor(values);
      }),
  };
}

describe('the call budget', () => {
  it('lets a run use exactly its budget: the last call is made and the run exits 0', async () => {
    const result = await cli(['--stub', '--budget', '17']);
    expect(result.code).toBe(0);
    expect(result.text).toContain('calls: 17 of 17\n');
    expect(result.text).not.toContain('the budget was spent');
  });

  it('refuses a budget below the least the manifest says, before any call', async () => {
    const attempts = { count: 0 };
    const result = await cli(['--stub', '--budget', '16'], {}, verdictOnRing(attempts));
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('below the 17 calls');
    expect(attempts.count).toBe(0);
  });

  it('refuses the request that would pass the budget, reports the views left as not run, and exits 1', async () => {
    const attempts = { count: 0 };
    const result = await cli(['--stub', '--budget', '17'], { NEBURYX_SUMMARY_MAX_CALLS: '2' }, verdictOnRing(attempts));
    expect(result.code).toBe(1);
    expect(attempts.count).toBe(17);
    expect(result.text).toContain('(the budget was spent)');
    // two views hold AC-2000 and make 2 calls each: 15 views use the 17 calls and the last two are not run
    expect(result.text).toContain('gateway-address-with-a-business-title [demo]: not run');
    expect(result.text).toContain('transfers-from-a-business-account [demo]: not run');
    expect(result.text).toContain('views run 15, not run 2');
  });

  it('stops a click in a regeneration when the budget is reached: the second request is not made', async () => {
    const attempts = { count: 0 };
    const result = await cli(['--stub', '--budget', '1', '--views', 'ring-on-one-device'], { NEBURYX_SUMMARY_MAX_CALLS: '5' }, verdictOnRing(attempts));
    expect(result.code).toBe(1);
    expect(attempts.count).toBe(1);
    expect(result.text).toContain('ring-on-one-device [demo]: failed (budget)');
    expect(result.text).toContain('calls: 1 of 1 (the budget was spent)');
  });

  it('counts every request once, makes no retry, and counts both categories against one budget', async () => {
    const attempts = { count: 0 };
    const result = await cli(['--stub', '--budget', '100'], { NEBURYX_SUMMARY_MAX_CALLS: '1' }, verdictOnRing(attempts));
    expect(attempts.count).toBe(17);
    expect(result.text).toContain('calls: 17 of 100');
  });
});

describe('the call budget with measuring', () => {
  it('is one budget for scoring and measuring: an exact fit exits 0, and one call short leaves a measurement not run and exits 1', async () => {
    // the ring view earns a further call (2 calls) and the cycle view makes 1; measuring then makes 2 + 3 + 4 calls: 12 in all
    const args = ['--stub', '--measure', '--views', 'ring-on-one-device,aml-cycle'];
    const env = { NEBURYX_SUMMARY_MAX_CALLS: '2', NEBURYX_SUMMARY_MAX_INPUT_TOKENS: '300000' };
    const exact = await cli([...args, '--budget', '12'], env, verdictOnRing({ count: 0 }));
    expect(exact.code).toBe(0);
    expect(exact.text).toContain('calls: 12 of 12\n');
    const short = await cli([...args, '--budget', '11'], env, verdictOnRing({ count: 0 }));
    expect(short.code).toBe(1);
    expect(short.text).toContain('sample-300-heavy [sample]: 300 elements');
    expect(short.text).toContain('not measured (not run: the budget was spent or the run was stopped)');
    expect(short.text).toContain('(the budget was spent)');
  });
});
