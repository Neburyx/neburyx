import type { AiMappingView } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createEvalPlanner } from './replay-planner.js';

const VIEW: AiMappingView = { types: [{ name: 'widget', kind: 'entity', properties: [] }, { name: 'attr_type', kind: 'entity', properties: [] }, { name: 'attr_link', kind: 'relationship', properties: [], ends: [{ from: 'widget', to: 'attr_type', timed: false }] }] };
const ASKED = 'Which widget has the same attr_type as ‹widget#1›?';
const PLAN = { kind: 'plan', templateId: 'shared-attribute', templateVersion: 1, params: { ref: { entityType: 'widget', stableId: '‹widget#1›' }, attributeType: 'attr_type', via: 'attr_link' }, rationale: 'Records that share an attribute.' };

async function rig(entry: { plan: string; repair?: string } | undefined) {
  const probe = await createEvalPlanner({ view: VIEW, replay: {} });
  const text = probe.rebuild(ASKED);
  if (text === undefined) throw new Error('the probe question is blocked');
  return createEvalPlanner({ view: VIEW, replay: entry === undefined ? {} : { [text]: entry } });
}

describe('the replay planner', () => {
  it('answers with the plan the recorded reply holds and says it was not repaired', async () => {
    const planner = await rig({ plan: JSON.stringify(PLAN) });
    expect(await planner.answer(ASKED)).toEqual({ kind: 'answered', plan: PLAN, repaired: false });
  });

  it('uses the recorded repair reply after an invalid first reply and says so', async () => {
    const planner = await rig({ plan: 'no plan', repair: JSON.stringify(PLAN) });
    expect(await planner.answer(ASKED)).toEqual({ kind: 'answered', plan: PLAN, repaired: true });
  });

  it('reports the call that has no recorded reply, for the question and for the repair', async () => {
    expect(await (await rig(undefined)).answer(ASKED)).toEqual({ kind: 'no-reply', call: 'plan' });
    expect(await (await rig({ plan: 'no plan' })).answer(ASKED)).toEqual({ kind: 'no-reply', call: 'repair' });
  });

  it('reports a wording the allowlist blocks without giving the planner any text', async () => {
    const planner = await rig({ plan: JSON.stringify(PLAN) });
    expect(await planner.answer('Which widget has the zzxqv attr_type as ‹widget#1›?')).toEqual({ kind: 'blocked' });
    expect(planner.rebuild('Which widget has the zzxqv attr_type as ‹widget#1›?')).toBeUndefined();
  });

  it('rebuilds a wording with one span for each placeholder', async () => {
    const planner = await rig(undefined);
    expect(planner.rebuild(ASKED)).toBe(ASKED);
  });
});
