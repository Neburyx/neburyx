import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptRecordOf, type ModelProvider } from '@neburyx/ee-ask';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { caseOf, loadCases } from '../cases.js';
import { realHooks } from '../testing/eval-hooks.js';
import { cli } from '../testing/harness.js';
import type { EvalHooks } from './hooks.js';
import { elementsOf, estimatedTokensOf, proposalOf, scaledReading, utf8Bytes, type Measurement } from './measure.js';

const outside = mkdtempSync(join(tmpdir(), 'nbx-measure-out-'));
afterAll(() => rmSync(outside, { recursive: true, force: true }));
const set = loadCases();
const base = set.cases.find((each) => each.id === 'aml-fan-in');
if (base === undefined) throw new Error('no aml-fan-in');

const measurementSchema = z.object({ id: z.string(), kind: z.string(), elements: z.number(), measured: z.boolean(), missing: z.string().optional(), bytes: z.number().optional(), estimatedTokens: z.number().optional(), inputTokens: z.number().optional(), bytesPerToken: z.number().optional() });
const reportSchema = z.object({ measurements: z.array(measurementSchema), proposal: z.object({ proposed: z.boolean(), bytesPerToken: z.number().optional(), maxInputTokens: z.number().optional(), missing: z.array(z.string()) }), usage: z.object({ calls: z.number() }) });

/** Hooks whose provider states the input tokens a rule gives for the elements of a request, with cache counts when a test asks. */
function counting(tokensFor: (elements: number) => number, over: { cacheRead?: number; cacheWrite?: number; fail?: (elements: number) => boolean; unknown?: boolean } = {}): EvalHooks<ModelProvider> {
  return {
    ...realHooks,
    scriptedProvider: () => ({
      complete: async (request) => {
        const elements = request.values.split('\n').filter((line) => /^[ne]\d+ \|/u.test(line)).length;
        if (over.fail?.(elements) === true) return { status: 'failed', code: 'unreachable', prompt: promptRecordOf(request) };
        return {
          status: 'ok',
          text: JSON.stringify({ sentences: [] }),
          usage: over.unknown === true ? { kind: 'unknown' } : { kind: 'known', inputTokens: tokensFor(elements), outputTokens: 5, ...(over.cacheRead === undefined ? {} : { cacheReadTokens: over.cacheRead }), ...(over.cacheWrite === undefined ? {} : { cacheWriteTokens: over.cacheWrite }) },
          model: 'claude-sonnet-5-5',
          prompt: promptRecordOf(request),
        };
      },
    }),
  };
}

async function measure(hooks: EvalHooks<ModelProvider>, extra: string[] = [], env: Record<string, string> = {}) {
  const result = await cli(['--stub', '--measure-only', '--json', ...extra], env, hooks);
  return { result, report: reportSchema.parse(JSON.parse(result.text)) };
}

describe('the views of a measuring run', () => {
  it('are the labelled views and samples of exactly 10, 100 and 300 elements built from a view, the same every time, with new ids and the same types', () => {
    for (const size of [10, 100, 300]) {
      const first = scaledReading(base, size);
      expect(elementsOf(first), String(size)).toBe(size);
      expect(JSON.stringify(scaledReading(base, size))).toBe(JSON.stringify(first));
      expect(new Set(first.nodes.map((node) => node.ref.stableId)).size).toBe(first.nodes.length);
      expect(new Set(first.nodes.map((node) => node.ref.entityType))).toEqual(new Set(['account']));
      for (const edge of first.edges) expect(first.nodes.some((node) => node.ref.stableId === edge.from.stableId)).toBe(true);
    }
  });

  it('are measured with one request each: the views selected and the three samples, and no repair call', async () => {
    const { report } = await measure(counting((elements) => 100 + 30 * elements), ['--views', 'aml']);
    expect(report.measurements.map((each) => each.id)).toEqual([...set.cases.filter((each) => each.shape !== undefined).map((each) => each.id), 'sample-10', 'sample-100', 'sample-300']);
    expect(report.usage.calls).toBe(10);
  });

  it('send their request through a provider with caching off: a live measuring run builds the provider with the cache switched off, and a plain run does not', async () => {
    const seen: Record<string, string | undefined>[] = [];
    const spying: EvalHooks<ModelProvider> = { ...realHooks, liveProvider: async (env, _folder, settings) => (seen.push(env), { provider: realHooks.scriptedProvider(() => JSON.stringify({ sentences: [] })), model: settings.model }) };
    const env = { NEBURYX_SUMMARY_MAX_INPUT_TOKENS: '100000' };
    const first = await cli(['--budget', '40', '--out', join(outside, 'one'), '--folder', 'f', '--measure-only', '--views', 'aml-cycle'], env, spying);
    const second = await cli(['--budget', '40', '--out', join(outside, 'two'), '--folder', 'f', '--views', 'aml-cycle'], env, spying);
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(seen.map((each) => each['NEBURYX_AI_CACHE'])).toEqual(['off', undefined]);
  });

  it('measure a view whose reply does not fit the reply format, since the provider answered and counted its input: what the summary makes of the reply is not looked at', async () => {
    const hooks: EvalHooks<ModelProvider> = {
      ...realHooks,
      scriptedProvider: () => ({ complete: async (request) => ({ status: 'ok', text: 'not json at all', usage: { kind: 'known', inputTokens: 900, outputTokens: 4 }, model: 'm', prompt: promptRecordOf(request) }) }),
    };
    const { report } = await measure(hooks, ['--views', 'aml-cycle']);
    expect(report.measurements.find((each) => each.id === 'aml-cycle')).toMatchObject({ measured: true, inputTokens: 900 });
    expect(report.usage.calls).toBe(4);
  });
});

describe('a measurement', () => {
  it('holds the UTF-8 bytes of the instructions plus the values, the product\'s estimate, and the input tokens the provider counted with its cache read and write counts', async () => {
    const { report } = await measure(counting((elements) => 1000 + elements, { cacheRead: 200, cacheWrite: 100 }), ['--views', 'aml-cycle']);
    const view = report.measurements.find((each) => each.id === 'aml-cycle');
    expect(view).toMatchObject({ measured: true, elements: 8, inputTokens: 1000 + 8 + 200 + 100 });
    expect(view?.estimatedTokens).toBe(estimatedTokensOf(view?.bytes ?? 0));
    expect(view?.bytesPerToken).toBeCloseTo((view?.bytes ?? 0) / 1308, 6);
  });

  it('counts the bytes of a text with non-ASCII characters as UTF-8 bytes', () => {
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('a', '日本')).toBe(7);
    expect(estimatedTokensOf(utf8Bytes('éééé'))).toBe(3);
  });
});

describe('what the measurements support', () => {
  const view = (id: string, bytes: number, tokens: number): Measurement => ({ id, kind: 'view', elements: 5, measured: true, bytes, estimatedTokens: 0, inputTokens: tokens, bytesPerToken: bytes / tokens, tokensPerElement: tokens / 5 });
  const sample = (elements: number, bytes: number, tokens: number): Measurement => ({ ...view(`sample-${elements}`, bytes, tokens), kind: 'sample', elements });
  const aml = new Set(['aml-a']);

  it('proposes the smallest bytes-per-token rounded down to one decimal and the guard from the most tokens at the cap times 1.2 rounded up to the next 1,000, worked out by hand', () => {
    const proposal = proposalOf([view('aml-a', 3140, 1000), view('x', 2960, 1000), sample(10, 3500, 1000), sample(300, 60_000, 18_001)], aml, 300);
    expect(proposal).toEqual({ proposed: true, bytesPerToken: 2.9, maxInputTokens: 22_000, missing: [] });
  });

  it('rounds the guard up only to the next 1,000, and keeps an exact multiple', () => {
    expect(proposalOf([view('aml-a', 4000, 1000), sample(300, 80_000, 20_000)], aml, 300).maxInputTokens).toBe(24_000);
    expect(proposalOf([view('aml-a', 4000, 1000), sample(300, 80_000, 20_001)], aml, 300).maxInputTokens).toBe(25_000);
  });

  it('proposes nothing, and says what is missing, when a measurement failed, when no AML view was measured, and when no sample at the cap was measured', () => {
    const failed: Measurement = { id: 'aml-b', kind: 'view', elements: 5, measured: false, missing: 'the call failed' };
    expect(proposalOf([view('aml-a', 4000, 1000), sample(300, 80_000, 20_000), failed], aml, 300)).toMatchObject({ proposed: false, missing: ['aml-b: the call failed'] });
    expect(proposalOf([view('other', 4000, 1000), sample(300, 80_000, 20_000)], aml, 300)).toMatchObject({ proposed: false, missing: ['no AML view was measured'] });
    expect(proposalOf([view('aml-a', 4000, 1000), sample(100, 80_000, 20_000)], aml, 300)).toMatchObject({ proposed: false, missing: ['no sample of 300 elements was measured'] });
  });

  it('through a run: unknown usage, a failed call and a sample refused by the size guard each give no proposal, and a refused sample makes no request', async () => {
    const unknown = await measure(counting(() => 1, { unknown: true }));
    expect(unknown.report.proposal.proposed).toBe(false);
    expect(unknown.report.measurements.every((each) => !each.measured)).toBe(true);
    const failed = await measure(counting((elements) => 100 + elements, { fail: (elements) => elements > 200 }));
    expect(failed.report.proposal).toMatchObject({ proposed: false });
    expect(failed.report.measurements.find((each) => each.id === 'sample-300')).toMatchObject({ measured: false, missing: 'the call failed' });
    const refused = await measure(counting((elements) => 100 + elements), [], { NEBURYX_SUMMARY_MAX_INPUT_TOKENS: '3000' });
    expect(refused.report.measurements.find((each) => each.id === 'sample-300')).toMatchObject({ measured: false, missing: 'refused by the size guard: no request was made' });
    expect(refused.report.proposal.proposed).toBe(false);
    expect(refused.report.usage.calls).toBe(set.cases.length + 3 - 1);
    const whole = await measure(counting((elements) => 100 + elements));
    expect(whole.report.proposal.proposed).toBe(true);
  });

  it('says `not measured` and proposes nothing for the scripted provider', async () => {
    const text = (await cli(['--stub', '--measure-only', '--views', 'aml-cycle'])).text;
    expect(text).toContain('not measured: a scripted provider states no token counts; nothing is proposed');
    expect(text).toContain('not measured (a scripted provider states no token counts)');
  });

  it('holds sizes and counts only: nothing of the text sent', async () => {
    const { result } = await measure(counting((elements) => 100 + elements), ['--views', 'aml-cycle']);
    expect(result.text).not.toContain('AC-7001');
    expect(result.text).not.toContain('title:');
  });
});
