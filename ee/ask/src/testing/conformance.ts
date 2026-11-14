import assert from 'node:assert/strict';
import { promptRecordOf, type FailureCode, type ModelAnswer, type ModelProvider, type ModelRequest, type TokenUsage } from '../provider.js';

export const CONFORMANCE_SCENARIOS = [
  'ok-known-usage',
  'ok-unknown-usage',
  'refused',
  'timeout',
  'rate-limited',
  'rejected',
  'provider-error',
  'unreachable',
  'bad-reply',
  'truncated',
  'model-asks-for-a-tool',
] as const;

export type ConformanceScenario = (typeof CONFORMANCE_SCENARIOS)[number];

/** What a provider's test supplies: the provider, and a way to make the next call behave as a scenario says. */
export interface ConformanceRig {
  readonly provider: ModelProvider;
  readonly arrange: (scenario: ConformanceScenario) => void | Promise<void>;
}

export interface ConformanceCase {
  readonly name: string;
  readonly run: (rig: ConformanceRig) => Promise<void>;
}

const REQUEST: ModelRequest = { promptId: 'conformance', version: 1, instructions: 'Answer in one word.', values: 'Who is here?' };

const FAILURE_SCENARIOS: readonly (readonly [ConformanceScenario, FailureCode])[] = [
  ['timeout', 'timeout'],
  ['rate-limited', 'rate-limited'],
  ['rejected', 'rejected'],
  ['provider-error', 'provider-error'],
  ['unreachable', 'unreachable'],
  ['bad-reply', 'bad-reply'],
  ['truncated', 'truncated'],
  ['model-asks-for-a-tool', 'bad-reply'],
];

async function call(rig: ConformanceRig, scenario: ConformanceScenario): Promise<ModelAnswer> {
  await rig.arrange(scenario);
  return rig.provider.complete(REQUEST, new AbortController().signal);
}

function assertPromptRecord(answer: ModelAnswer): void {
  assert.ok(answer.prompt, 'the answer carries a prompt record');
  assert.deepEqual(answer.prompt, promptRecordOf(REQUEST));
  assert.match(answer.prompt.sha256, /^[0-9a-f]{64}$/);
}

function assertNoText(answer: ModelAnswer): void {
  assert.equal('text' in answer, false, 'the answer holds no text');
}

function assertUsage(usage: TokenUsage | undefined): void {
  assert.ok(usage !== undefined, 'a failure carries a usage, known or unknown');
  if (usage.kind === 'unknown') return;
  assert.ok(Number.isInteger(usage.inputTokens) && usage.inputTokens >= 0);
  assert.ok(Number.isInteger(usage.outputTokens) && usage.outputTokens >= 0);
  for (const count of [usage.cacheReadTokens, usage.cacheWriteTokens]) {
    assert.ok(count === undefined || (Number.isInteger(count) && count >= 0), 'a cache count is absent or a whole non-negative number');
  }
}

const failureCase = ([scenario, code]: readonly [ConformanceScenario, FailureCode]): ConformanceCase => ({
  name: `scenario ${scenario}`,
  async run(rig) {
    const answer = await call(rig, scenario);
    assert.equal(answer.status, 'failed');
    assert.equal(answer.status === 'failed' ? answer.code : undefined, code);
    assertPromptRecord(answer);
    assertNoText(answer);
    assertUsage(answer.status === 'failed' ? answer.usage : undefined);
  },
});

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
  {
    name: 'scenario ok-known-usage',
    async run(rig) {
      const answer = await call(rig, 'ok-known-usage');
      assert.equal(answer.status, 'ok');
      if (answer.status !== 'ok') return;
      assert.ok(answer.text.length > 0, 'the answer has text');
      assert.ok(answer.model.length > 0, 'the answer names the model');
      assert.equal(answer.usage.kind, 'known');
      assertUsage(answer.usage);
      assertPromptRecord(answer);
    },
  },
  {
    name: 'scenario ok-unknown-usage',
    async run(rig) {
      const answer = await call(rig, 'ok-unknown-usage');
      assert.equal(answer.status, 'ok');
      if (answer.status !== 'ok') return;
      assert.deepEqual(answer.usage, { kind: 'unknown' }, 'an unknown usage is unknown, never zeros');
      assertPromptRecord(answer);
    },
  },
  {
    name: 'scenario refused',
    async run(rig) {
      const answer = await call(rig, 'refused');
      assert.equal(answer.status, 'refused');
      if (answer.status === 'refused') assert.ok(answer.usage, 'a refusal carries a usage');
      assertPromptRecord(answer);
      assertNoText(answer);
    },
  },
  ...FAILURE_SCENARIOS.map(failureCase),
];
