import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPromptRegistry } from '../prompts.js';
import type { ModelAnswer, ModelProvider } from '../provider.js';
import { CONFORMANCE_CASES, CONFORMANCE_SCENARIOS, type ConformanceRig, type ConformanceScenario } from './conformance.js';
import { createFixtureProvider, replyKey, type FixtureReply } from './fixture.js';

const REPLIES: Readonly<Record<ConformanceScenario, FixtureReply>> = {
  'ok-known-usage': { kind: 'ok', text: 'a plan', usage: { kind: 'known', inputTokens: 12, outputTokens: 34 } },
  'ok-unknown-usage': { kind: 'ok', text: 'a plan' },
  refused: { kind: 'refused' },
  timeout: { kind: 'failed', code: 'timeout' },
  'rate-limited': { kind: 'failed', code: 'rate-limited' },
  rejected: { kind: 'failed', code: 'rejected' },
  'provider-error': { kind: 'failed', code: 'provider-error' },
  unreachable: { kind: 'failed', code: 'unreachable' },
  'bad-reply': { kind: 'failed', code: 'bad-reply' },
  truncated: { kind: 'failed', code: 'truncated' },
  'model-asks-for-a-tool': { kind: 'failed', code: 'bad-reply' },
};

async function fixtureRig(overrides: Partial<Record<ConformanceScenario, FixtureReply>> = {}, wrap: (provider: ModelProvider) => ModelProvider = (provider) => provider): Promise<ConformanceRig> {
  const built = await buildPromptRegistry();
  if (!built.ok) throw new Error(built.problems.join('; '));
  let next: FixtureReply = REPLIES['ok-known-usage'];
  const fixture = createFixtureProvider({ registry: built.registry, replies: { [replyKey('ask.plan', 1)]: () => next } });
  return {
    provider: wrap(fixture),
    registry: built.registry,
    arrange(scenario) {
      next = overrides[scenario] ?? REPLIES[scenario];
    },
    callsMade: () => fixture.calls.length,
  };
}

async function failedCases(rig: ConformanceRig): Promise<string[]> {
  const failed: string[] = [];
  for (const conformanceCase of CONFORMANCE_CASES) {
    try {
      await conformanceCase.run(rig);
    } catch {
      failed.push(conformanceCase.name);
    }
  }
  return failed;
}

describe('the conformance suite', () => {
  it('covers every scenario, and the parameter case', () => {
    const names = CONFORMANCE_CASES.map((conformanceCase) => conformanceCase.name);
    for (const scenario of CONFORMANCE_SCENARIOS) expect(names).toContain(`scenario ${scenario}`);
    expect(names).toContain('a missing or undeclared parameter throws a PromptError before any outbound call');
    expect(new Set(names).size).toBe(names.length);
  });

  it('imports no test runner', () => {
    const text = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'conformance.ts'), 'utf8');
    expect(text).not.toMatch(/from\s+['"]vitest['"]|from\s+['"]jest['"]|node:test/);
  });

  describe.each(CONFORMANCE_CASES)('passes for the fixture provider: $name', (conformanceCase) => {
    it('runs', async () => {
      await conformanceCase.run(await fixtureRig());
    });
  });
});

describe('the conformance suite on a provider that is wrong', () => {
  it('fails an unknown usage that is reported as zeros', async () => {
    const zeros = (provider: ModelProvider): ModelProvider => ({
      complete: async (request, signal) => {
        const answer = await provider.complete(request, signal);
        return answer.status === 'ok' && answer.usage.kind === 'unknown' ? { ...answer, usage: { kind: 'known', inputTokens: 0, outputTokens: 0 } } : answer;
      },
    });
    expect(await failedCases(await fixtureRig({}, zeros))).toEqual(['scenario ok-unknown-usage']);
  });

  it('fails a failure that carries no usage at all, and passes one that carries a known usage', async () => {
    const without = (provider: ModelProvider): ModelProvider => ({
      complete: async (request, signal) => {
        const answer = await provider.complete(request, signal);
        if (answer.status !== 'failed') return answer;
        const { usage: _usage, ...rest } = answer;
        return rest;
      },
    });
    expect(await failedCases(await fixtureRig({}, without))).toEqual(['scenario timeout', 'scenario rate-limited', 'scenario rejected', 'scenario provider-error', 'scenario unreachable', 'scenario bad-reply', 'scenario truncated', 'scenario model-asks-for-a-tool']);
    const known: FixtureReply = { kind: 'failed', code: 'truncated', usage: { kind: 'known', inputTokens: 12, outputTokens: 256 } };
    expect(await failedCases(await fixtureRig({ truncated: known }))).toEqual([]);
  });

  it('fails a failure whose usage is not whole non-negative counts', async () => {
    const odd: FixtureReply = { kind: 'failed', code: 'truncated', usage: { kind: 'known', inputTokens: 1.5, outputTokens: 2 } };
    expect(await failedCases(await fixtureRig({ truncated: odd }))).toEqual(['scenario truncated']);
  });

  it('fails a tool request that is returned as text', async () => {
    const rig = await fixtureRig({ 'model-asks-for-a-tool': { kind: 'ok', text: '{"tool_use":"run_query"}' } });
    expect(await failedCases(rig)).toEqual(['scenario model-asks-for-a-tool']);
  });

  it('fails an answer with no prompt record', async () => {
    const withoutRecord = (provider: ModelProvider): ModelProvider => ({
      complete: async (request, signal) => {
        const { prompt: _prompt, ...rest } = await provider.complete(request, signal);
        return rest as unknown as ModelAnswer;
      },
    });
    const failed = await failedCases(await fixtureRig({}, withoutRecord));
    expect(failed).toEqual(CONFORMANCE_SCENARIOS.map((scenario) => `scenario ${scenario}`));
  });

  it('fails a provider that wraps the registry error, or sends a call before it', async () => {
    const wrapping = (provider: ModelProvider): ModelProvider => ({
      complete: async (request, signal) => {
        try {
          return await provider.complete(request, signal);
        } catch (error) {
          throw new Error(`wrapped: ${String(error)}`);
        }
      },
    });
    expect(await failedCases(await fixtureRig({}, wrapping))).toEqual(['a missing or undeclared parameter throws a PromptError before any outbound call']);
  });
});
