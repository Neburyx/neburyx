import type { AiMappingView } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_PROMPTS, buildPromptRegistry } from '../prompts.js';
import { createFixtureProvider, replyKey, type FixtureReply, type FixtureReplySource } from '../testing/fixture.js';
import { createLedger, createRecorder } from './record.js';
import { createEvalPlanner } from './replay-planner.js';

const VIEW: AiMappingView = { types: [{ name: 'widget', kind: 'entity', properties: [] }, { name: 'attr_type', kind: 'entity', properties: [] }, { name: 'attr_link', kind: 'relationship', properties: [], ends: [{ from: 'widget', to: 'attr_type', timed: false }] }] };
const ASKED = 'Which widget has the same attr_type as ‹widget#1›?';
const OTHER = 'Which widget has the same attr_type as ‹widget#2›?';
const PLAN = JSON.stringify({ kind: 'plan', templateId: 'shared-attribute', templateVersion: 1, params: { ref: { entityType: 'widget', stableId: '‹widget#1›' }, attributeType: 'attr_type', via: 'attr_link' }, rationale: 'Records that share an attribute.' });
const USAGE = { kind: 'known', inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } as const;

async function rig(plan: FixtureReplySource, repair: FixtureReplySource = plan, budget = 10) {
  const built = await buildPromptRegistry({});
  if (!built.ok) throw new Error('prompts');
  const provider = createFixtureProvider({ registry: built.registry, replies: { [replyKey('ask.plan', BUILT_IN_PROMPTS['ask.plan'].version)]: plan, [replyKey('ask.plan.repair', BUILT_IN_PROMPTS['ask.plan.repair'].version)]: repair } });
  const ledger = createLedger(budget, 'fixture-model');
  const recorder = await createRecorder({ view: VIEW, provider, ledger });
  return { recorder, provider, ledger };
}

const ok = (text: string): FixtureReply => ({ kind: 'ok', text, usage: USAGE });

describe('the budgeted recorder', () => {
  it('records the reply of each question under its rebuilt text, and the replay answers the same plan again', async () => {
    const { recorder } = await rig(ok(PLAN));
    expect(await recorder.record('one', ASKED)).toBe('recorded');
    const replay = recorder.replay();
    expect(Object.keys(replay)).toEqual([ASKED]);
    const again = await createEvalPlanner({ view: VIEW, replay });
    expect(await again.answer(ASKED)).toMatchObject({ kind: 'answered', repaired: false, plan: { kind: 'plan', templateId: 'shared-attribute' } });
  });

  it('records the repair reply too, counts both calls, and the replay says it was repaired', async () => {
    const { recorder, ledger } = await rig(ok('not a plan'), ok(PLAN));
    expect(await recorder.record('one', ASKED)).toBe('recorded');
    expect(ledger.run().calls).toBe(2);
    expect(recorder.replay()[ASKED]).toEqual({ plan: 'not a plan', repair: PLAN });
    expect(await (await createEvalPlanner({ view: VIEW, replay: recorder.replay() })).answer(ASKED)).toMatchObject({ kind: 'answered', repaired: true });
  });

  it('never makes a call past the budget, also in the middle of a repair, and records only the questions fully answered', async () => {
    const { recorder, provider } = await rig(ok(PLAN), ok('not a plan'), 3);
    const bad = await rig(ok('not a plan'), ok('not a plan'), 3);
    expect(await recorder.record('one', ASKED)).toBe('recorded');
    expect(await bad.recorder.record('one', ASKED)).toBe('recorded');
    expect(bad.ledger.run().calls).toBe(2);
    expect(await bad.recorder.record('two', OTHER)).toBe('stopped');
    const run = bad.ledger.run();
    expect(run).toMatchObject({ calls: 3, budget: 3, recorded: 1, stoppedByBudget: true });
    expect(bad.provider.calls).toHaveLength(3);
    expect(Object.keys(bad.recorder.replay())).toEqual([ASKED]);
    expect(provider.calls).toHaveLength(1);
  });

  it('counts a failed call against the budget, does not retry it, and leaves the question out of the replay', async () => {
    const { recorder, provider, ledger } = await rig({ kind: 'failed', code: 'rate-limited' });
    expect(await recorder.record('one', ASKED)).toBe('failed');
    expect(provider.calls).toHaveLength(1);
    expect(ledger.run()).toMatchObject({ calls: 1, recorded: 0, failures: [{ id: 'one', code: 'rate-limited' }] });
    expect(recorder.replay()).toEqual({});
  });

  it('records a refusal of the model, and the replay answers model-refused', async () => {
    const { recorder } = await rig({ kind: 'refused', usage: USAGE });
    expect(await recorder.record('one', ASKED)).toBe('recorded');
    expect(recorder.replay()[ASKED]).toEqual({ plan: '', refused: true });
    const again = await createEvalPlanner({ view: VIEW, replay: recorder.replay() });
    expect(await again.answer(ASKED)).toMatchObject({ kind: 'answered', plan: { kind: 'unsupported', family: 'model-refused' } });
  });

  it('makes no call for a blocked wording', async () => {
    const { recorder, provider } = await rig(ok(PLAN));
    expect(await recorder.record('one', 'Which widget has the zzxqv attr_type as ‹widget#1›?')).toBe('blocked');
    expect(provider.calls).toHaveLength(0);
  });

  it('records the model, the prompt versions and the token counts of the run, and counts a call without counts', async () => {
    const { recorder, ledger } = await rig(ok(PLAN));
    await recorder.record('one', ASKED);
    const unknown = await rig({ kind: 'ok', text: PLAN, usage: { kind: 'unknown' } });
    await unknown.recorder.record('one', ASKED);
    expect(ledger.run()).toMatchObject({ model: 'fixture-model', prompts: [{ id: 'ask.plan', version: BUILT_IN_PROMPTS['ask.plan'].version }], tokens: { in: 10, out: 5, cacheRead: 2, cacheWrite: 0, callsWithoutCounts: 0 } });
    expect(unknown.ledger.run().tokens.callsWithoutCounts).toBe(1);
  });
});
