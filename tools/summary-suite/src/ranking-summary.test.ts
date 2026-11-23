import type { SummarySentence } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { replyOf, startRig } from './testing/rig.js';
import { node, prop, reading } from './view.js';

const AMOUNTS = Array.from({ length: 25 }, (_, index) => ((index * 7) % 25) + 1);
const view = () => reading(AMOUNTS.map((value, index) => node('widget', `W-${String(index + 1).padStart(2, '0')}`, `Item ${String(index + 1).padStart(2, '0')}`, [prop('amountDue', value, false, 'number')])));

/** The keys the view gave the 25 entities, and the entity that holds the largest and the smallest value. */
async function keysOf() {
  const probe = startRig({ replies: [replyOf()], settings: { maxCalls: 1 } });
  await probe.summarize(view());
  const sent = probe.requests[0]?.values ?? '';
  const lines = sent.split('\n').filter((line) => /^n\d+ \|/u.test(line));
  const held = lines.map((line) => ({ key: line.slice(0, line.indexOf(' ')), title: /title: "([^"]+)"/u.exec(line)?.[1] ?? '', value: Number(/amountDue: (\d+)/u.exec(line)?.[1]) }));
  const top = held.reduce((best, each) => (each.value > best.value ? each : best));
  const bottom = held.reduce((best, each) => (each.value < best.value ? each : best));
  const other = held.find((each) => each !== top && each !== bottom);
  return { keys: held.map((each) => each.key), top, bottom, other: other ?? top };
}

async function closingOf(sentences: readonly SummarySentence[]) {
  const rig = startRig({ replies: [replyOf(...sentences)], settings: { maxCalls: 1 } });
  const outcome = await rig.summarize(view());
  const event = rig.events.find((each) => each.action === 'ai.case-summary.closed');
  const detail = (event as unknown as { detail: { summary: { sentencesKept: number; sentencesRemoved: number } } }).detail.summary;
  return { outcome, kept: detail.sentencesKept, removed: detail.sentencesRemoved, removals: rig.store.runs[0]?.removals ?? [] };
}

describe('a summary of 25 entities of one type that cites all 25', () => {
  it('keeps the largest and the smallest with their figures, and counts them in the closing event', async () => {
    const { keys, top, bottom } = await keysOf();
    const result = await closingOf([
      { text: `${top.title} has the largest amountDue, ${top.value}.`, cites: keys },
      { text: `${bottom.title} has the smallest amountDue, ${bottom.value}.`, cites: keys },
    ]);
    expect(result).toMatchObject({ kept: 2, removed: 0 });
  });

  it('removes the wrong element, the wrong figure and the one that cites 24, with the reason comparison, and counts them', async () => {
    const { keys, top, other } = await keysOf();
    const result = await closingOf([
      { text: `${other.title} has the largest amountDue, ${top.value}.`, cites: keys },
      { text: `${top.title} has the largest amountDue, ${other.value}.`, cites: keys },
      { text: `${top.title} has the largest amountDue, ${top.value}.`, cites: keys.slice(0, 24) },
      { text: `${top.title} has the largest amountDue, ${top.value}.`, cites: keys },
    ]);
    expect(result).toMatchObject({ kept: 1, removed: 3 });
    expect(result.removals.flatMap((each) => each.rejected.map((rejected) => rejected.reason))).toEqual(['comparison', 'comparison', 'comparison']);
  });
});
