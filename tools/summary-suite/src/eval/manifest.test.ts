import { describe, expect, it } from 'vitest';
import { loadCases } from '../cases.js';
import { cli } from '../testing/harness.js';
import { manifestOf, selectViews } from './manifest.js';

const set = loadCases();
const settings = { model: 'm', timeoutMs: 1, totalTimeoutMs: 1, maxCalls: 5, maxElements: 300, maxOutputTokens: 4000, maxInputTokens: 23_000, retentionDays: 30 };

describe('the manifest of a run', () => {
  it('is, for the scoring views, the views times the call limit at most and one call a view at least, worked out by hand', () => {
    expect(manifestOf(set.cases, settings)).toEqual({ categories: [{ name: 'scoring', views: 17, mostCalls: 85, leastCalls: 17 }], mostCalls: 85, leastCalls: 17 });
    expect(manifestOf(selectViews(set.cases, 'aml'), { ...settings, maxCalls: 3 })).toEqual({ categories: [{ name: 'scoring', views: 7, mostCalls: 21, leastCalls: 7 }], mostCalls: 21, leastCalls: 7 });
  });

  it('has, for measuring alone and for both, a category of the views and three samples at one call each, worked out by hand', () => {
    const aml = selectViews(set.cases, 'aml');
    expect(manifestOf(aml, settings, 'only')).toEqual({ categories: [{ name: 'measurement', views: 14, mostCalls: 14, leastCalls: 14 }], mostCalls: 14, leastCalls: 14 });
    expect(manifestOf(aml, { ...settings, maxCalls: 3 }, 'add')).toEqual({
      categories: [
        { name: 'scoring', views: 7, mostCalls: 21, leastCalls: 7 },
        { name: 'measurement', views: 14, mostCalls: 14, leastCalls: 14 },
      ],
      mostCalls: 35,
      leastCalls: 21,
    });
    expect(manifestOf(aml, { ...settings, maxElements: 100 }, 'only').categories[0]?.views).toBe(11);
  });

  it('is printed by --dry-run --measure with both categories', async () => {
    const result = await cli(['--dry-run', '--measure', '--views', 'aml']);
    expect(result.out).toContain('scoring: 7 views, at most 35 calls, at least 7');
    expect(result.out).toContain('measurement: 14 views, at most 14 calls, at least 14');
    expect(result.out).toContain('calls: at most 49, budget needed at least 21');
  });

  it('is printed by --dry-run, which makes no call and reads no key, with the model, the call limit and the budget needed at least', async () => {
    const result = await cli(['--dry-run', '--views', 'aml'], { NEBURYX_SUMMARY_MAX_CALLS: '3', NEBURYX_ASK_API_KEY_FILE: '/nonexistent/key' });
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      'mode: live',
      'model: claude-sonnet-5-5',
      'call limit of a click: 3',
      'scoring: 7 views, at most 21 calls, at least 7',
      'calls: at most 21, budget needed at least 7',
      'size guard: 25000 tokens',
    ]);
  });
});
