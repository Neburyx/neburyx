import { openToken } from '@neburyx/ee-ask';
import { describe, expect, it } from 'vitest';
import { defined, expectCited, expectNoText, keysOfSentText, sentencesOf } from './checks.js';
import { edge, node, prop, reading } from './view.js';
import { INVESTIGATION, KEYS, replyOf, startRig } from './testing/rig.js';

const account = node('account', 'AC-1', 'Ana Silva', [prop('status', 'open')]);
const device = node('device', 'DV-1', 'Phone DV-1');
const view = reading([account, device], [edge('USES_DEVICE', 'r1', account.ref, device.ref)]);

describe('one whole click over a scripted model', () => {
  it('answers ok with cited sentences and a token that opens, after one request, with its events and its run row', async () => {
    const rig = startRig({ replies: [replyOf({ text: 'AC-1 uses the device DV-1.', cites: ['n1', 'n2', 'e1'] })] });
    const outcome = await rig.summarize(view);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(sentencesOf(outcome)).toEqual([{ text: 'AC-1 uses the device DV-1.', cites: ['n1', 'n2', 'e1'] }]);
    expectCited(outcome.sentences, keysOfSentText(outcome.sent));
    const opened = openToken(KEYS, outcome.summaryToken, { investigationId: INVESTIGATION, actorId: 'analyst-1', policyVersion: 'policy-1', now: Date.now() });
    expect(opened.ok).toBe(true);
    expect(rig.requests).toHaveLength(1);
    expect(rig.requests[0]?.values).toBe(outcome.sent);
    const runId = rig.store.runs[0]?.id;
    expect(rig.events.map((event) => event.action)).toEqual(['ai.case-summary', 'ai.case-summary.closed']);
    for (const event of rig.events) expect(JSON.stringify(event.detail)).toContain(defined(runId, 'the run id'));
    expect(rig.store.runs).toHaveLength(1);
    expect(rig.store.runs[0]).toMatchObject({ outcome: 'ok', calls: 1 });
    expect(rig.store.runs[0]?.callStarts[0]?.valuesText).toBe(outcome.sent);
  });

  it('keeps no text of the values or of the reply in any event', async () => {
    const rig = startRig({ replies: [replyOf({ text: 'AC-1 uses the device DV-1.', cites: ['n1'] })] });
    await rig.summarize(view);
    expectNoText(rig.events, ['Ana Silva', 'AC-1 uses the device']);
  });

  it('marks a sentence storable when its value is a slot of a cited element, and seals no value of the view in the templates', async () => {
    const rig = startRig({ replies: [replyOf({ text: 'AC-1 is open.', cites: ['n1'] }), ] });
    const outcome = await rig.summarize(view);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.sentences[0]).toMatchObject({ storable: true });
    const opened = openToken(KEYS, outcome.summaryToken, { investigationId: INVESTIGATION, actorId: 'analyst-1', policyVersion: 'policy-1', now: Date.now() });
    expect(opened.ok).toBe(true);
    const templates = JSON.stringify(opened.ok ? opened.payload.templates : undefined);
    expect(templates).toContain('"kind":"value"');
    expect(templates).not.toMatch(/open|Ana Silva/u);
  });

  it('marks a sentence storable when its number is the count of cited entities of a type, sealing a tally slot and no number word', async () => {
    const rig = startRig({ replies: [replyOf({ text: 'AC-1 uses one device.', cites: ['n1', 'n2'] })] });
    const outcome = await rig.summarize(view);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.sentences[0]).toMatchObject({ storable: true });
    const opened = openToken(KEYS, outcome.summaryToken, { investigationId: INVESTIGATION, actorId: 'analyst-1', policyVersion: 'policy-1', now: Date.now() });
    const templates = opened.ok ? opened.payload.templates : [];
    expect(JSON.stringify(templates)).toContain('"kind":"tally"');
    expect(templates[0]).toMatchObject({ storable: true, text: '‹account#1› uses ‹count#1›.' });
  });
});
