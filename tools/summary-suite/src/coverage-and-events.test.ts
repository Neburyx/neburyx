import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { expectNoText } from './checks.js';
import { failure, replyOf, startRig } from './testing/rig.js';
import { edge, node, reading } from './view.js';

const eventSchema = z.object({ detail: z.object({ summary: z.record(z.string(), z.unknown()) }) });

const a = node('account', 'AC-1', 'AC-1');
const b = node('account', 'AC-2', 'AC-2');
const view = (over: Parameters<typeof reading>[2] = {}) => reading([a, b], [edge('USES_DEVICE', 'r1', a.ref, b.ref)], over);
const good = { text: 'The account AC-1 is listed.', cites: ['n1'] };

describe('the coverage line is the server\'s', () => {
  it('is built from the counts and their labels and from the cites that survived, and a model that writes its own coverage claim has it removed and changes nothing of the line', async () => {
    const plain = await startRig({ replies: [replyOf(good)] }).summarize(view({ notRetrieved: { value: 38, quality: 'estimated', scope: 'coverage' } }));
    const boasting = await startRig({ replies: [replyOf(good, { text: 'Coverage is complete: 99 of 99 elements are covered.', cites: ['n1', 'n2', 'e1'] })] }).summarize(view({ notRetrieved: { value: 38, quality: 'estimated', scope: 'coverage' } }));
    expect(plain.status === 'ok' && plain.coverage).toEqual({ retrieval: '2 shown · ~38 not yet retrieved (estimated)', summary: 'The draft cites 1 of the 3 shown elements.' });
    expect(boasting.status === 'partial' && boasting.coverage).toEqual({ retrieval: '2 shown · ~38 not yet retrieved (estimated)', summary: 'The draft cites 1 of the 3 shown elements.' });
  });

  it('gives an unknown count no number', async () => {
    const outcome = await startRig({ replies: [replyOf(good)] }).summarize(view({ notRetrieved: { quality: 'unknown', scope: 'coverage' } }));
    expect(outcome.status === 'ok' && outcome.coverage.retrieval).toBe('2 shown · more not yet retrieved');
  });

  it('gives a lower bound its label', async () => {
    const outcome = await startRig({ replies: [replyOf(good)] }).summarize(view({ notRetrieved: { value: 500, quality: 'lowerBound', scope: 'coverage' } }));
    expect(outcome.status === 'ok' && outcome.coverage.retrieval).toBe('2 shown · ≥ 500 not yet retrieved (lower bound)');
  });
});

describe('the counts of the closing event', () => {
  const closing = (events: readonly { readonly action: string }[]) => events.filter((event) => event.action === 'ai.case-summary.closed');
  const summaryOf = (event: unknown): Record<string, unknown> => eventSchema.parse(event).detail.summary;

  it('holds the sentences kept and removed of the reply that was checked, and no text', async () => {
    const rig = startRig({ replies: [replyOf(good, { text: 'Listed.', cites: [] })], settings: { maxCalls: 1 } });
    await rig.summarize(view());
    expect(summaryOf(closing(rig.events)[0])).toMatchObject({ outcome: 'partial', sentencesKept: 1, sentencesRemoved: 1 });
    expectNoText(rig.events, ['The account AC-1 is listed.']);
  });

  it('holds the counts of the last checked reply when a later call fails', async () => {
    const rig = startRig({ replies: [replyOf(good, { text: 'This is evidence of fraud.', cites: ['n1'] }), failure('unreachable')] });
    await rig.summarize(view());
    expect(rig.requests).toHaveLength(2);
    expect(summaryOf(closing(rig.events)[0])).toMatchObject({ outcome: 'unreachable', sentencesKept: 1, sentencesRemoved: 1 });
  });

  it('holds neither count when no reply was checked', async () => {
    const rig = startRig({ replies: [failure('unreachable')] });
    await rig.summarize(view());
    const summary = summaryOf(closing(rig.events)[0]);
    expect(summary).not.toHaveProperty('sentencesKept');
    expect(summary).not.toHaveProperty('sentencesRemoved');
  });
});
