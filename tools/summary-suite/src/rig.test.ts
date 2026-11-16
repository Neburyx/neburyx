import { describe, expect, it } from 'vitest';
import { promptRecordOf } from '@neburyx/ee-ask';
import { checkedReplyOf, replyOf, startRig } from './testing/rig.js';
import { node, reading } from './view.js';

const good = { text: 'AC-1 is listed.', cites: ['n1'] };
const view = reading([node('account', 'AC-1', 'AC-1')]);

describe('the reply the checks judged last', () => {
  it('is the last reply that fits the reply format, so a later reply that does not fit is never taken for it', () => {
    const checked = replyOf(good);
    const unfit = [
      JSON.stringify({ sentences: [good], extra: 'field' }),
      JSON.stringify({ sentences: [{ ...good, extra: 'field' }] }),
      JSON.stringify({ sentences: [{ text: '', cites: ['n1'] }] }),
      JSON.stringify({ sentences: [{ text: 'x', cites: [''] }] }),
      replyOf(...Array.from({ length: 13 }, () => good)),
      'not json',
    ];
    for (const reply of unfit) expect(checkedReplyOf([checked, reply]), reply.slice(0, 30)).toEqual([good]);
    expect(checkedReplyOf([replyOf(...Array.from({ length: 12 }, () => good))])).toHaveLength(12);
    expect(checkedReplyOf([])).toEqual([]);
  });

  it('is captured for a scripted answer given as an object as it is for a text', async () => {
    const rig = startRig({
      replies: [(request) => ({ status: 'ok', text: replyOf(good), usage: { kind: 'unknown' }, model: 'claude-sonnet-5-5', prompt: promptRecordOf(request) })],
      settings: { maxCalls: 1 },
    });
    await rig.summarize(view);
    expect(rig.replies).toEqual([replyOf(good)]);
    expect(checkedReplyOf(rig.replies)).toEqual([good]);
  });
});
