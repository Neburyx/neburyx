import { JUDGE_MODULE, createCheckRunner, judgeSentences, parseJudged, type JudgeInput } from '@neburyx/ee-ai-runtime';
import type { GraphNode, SummaryReading } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { assembleText, rankedOf } from './assemble.js';
import { checkedTextOf } from './judge.js';
import { rejudge } from './rejudge.js';

type Property = GraphNode['properties'][number];
const ref = (stableId: string) => ({ sourceId: 'demo', entityType: 'widget', stableId });
const node = (stableId: string, title: string, properties: Property[]): GraphNode => ({ ref: ref(stableId), display: { title, type: 'widget' }, properties, qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const reading = (nodes: GraphNode[]): SummaryReading => ({ nodes, edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 });
const amount = (value: unknown, over: Partial<Property> = {}): Property => ({ key: 'amountDue', value, dataClass: 'number', masked: false, ...over });

describe('what a ranking may rest on, by the data class the gate returned', () => {
  it('holds a number as exact decimal text, a day and an instant as the key of the moment, and no value for what is masked, not shown, invalid or of a class with no order', () => {
    expect(rankedOf([amount(10), amount('9007199254740993'), amount('0.10')].map((property, index) => ({ ...property, key: `k${index}` })))).toEqual([
      { key: 'k0', dataClass: 'number', value: '10' },
      { key: 'k1', dataClass: 'number', value: '9007199254740993' },
      { key: 'k2', dataClass: 'number', value: '0.1' },
    ]);
    expect(rankedOf([
      { key: 'a', value: '2022-09-10', dataClass: 'date', masked: false },
      { key: 'b', value: '2022-09-10T12:00:00+02:00', dataClass: 'dateTime', masked: false },
      { key: 'c', value: '2022-09-10T12:00:00', dataClass: 'localDateTime', masked: false },
    ])).toEqual([
      { key: 'a', dataClass: 'date', value: '2022-09-10T00:00:00.000000000' },
      { key: 'b', dataClass: 'dateTime', value: '1662804000000000000' },
      { key: 'c', dataClass: 'localDateTime', value: '2022-09-10T12:00:00.000000000' },
    ]);
    expect(rankedOf([
      { key: 'm', value: '***', dataClass: 'text', masked: true },
      amount(undefined, { key: 'n' }),
      amount('abc', { key: 'o' }),
      amount(Number.NaN, { key: 'p' }),
      { key: 'q', value: '2026-02-31', dataClass: 'date', masked: false },
      { key: 'r', value: 'hello', dataClass: 'text', masked: false },
    ])).toEqual([
      { key: 'm', dataClass: 'text' },
      { key: 'n', dataClass: 'number' },
      { key: 'o', dataClass: 'number' },
      { key: 'p', dataClass: 'number' },
      { key: 'q', dataClass: 'date' },
      { key: 'r', dataClass: 'text' },
    ]);
  });

  it('holds no masked value: the held values hold nothing a mask hides', () => {
    const held = assembleText(reading([node('W-1', 'Item A', [amount('SECRET-1', { masked: true })]), node('W-2', 'Item B', [amount(5)])]));
    expect(JSON.stringify([...(held.rankedValues ?? [])])).not.toContain('SECRET');
  });
});

describe('the names of an element, as its line sent them', () => {
  it('holds the title and the id of an element of the view, once each, and no id for a title that merely resembles one', () => {
    const view = checkedTextOf(assembleText(reading([node('W-1', 'W-1', []), node('W-2', 'Unrelated title', [])])));
    expect(view.elementNames?.get('n1')).toEqual(['W-1']);
    expect(view.elementNames?.get('n2')).toEqual(['Unrelated title', 'W-2']);
  });

  it('keeps a title that has nothing to do with the id, so that a title-only ranking is verified and a wrong title with the right figure is not', () => {
    const items = [node('W-1', 'Alpha', [amount(10)]), node('W-2', 'Beta', [amount(2)])];
    const text = checkedTextOf(assembleText(reading(items)));
    const judge = (sentence: string) => judgeSentences([{ text: sentence, cites: ['n1', 'n2'] }], text).kept.length === 1;
    expect(judge('Alpha has the largest amountDue, 10.')).toBe(true);
    expect(judge('Beta has the largest amountDue, 10.')).toBe(false);
    expect(judge('Beta has the smallest amountDue, 2.')).toBe(true);
  });
});

describe('a draft judged again over the current reading', () => {
  const sentence = (text: string) => ({ text, cites: ['n1', 'n2'] });
  const inputs = [{ key: 'n1', kind: 'entity', ref: ref('W-1') }, { key: 'n2', kind: 'entity', ref: ref('W-2') }];
  const again = (text: string, current: SummaryReading) => rejudge({ sentences: [sentence(text)], inputRefs: inputs, mask: true } as never, current);
  const SAID = 'Alpha has the largest amountDue, 10.';
  const base = [node('W-1', 'Alpha', [amount(10)]), node('W-2', 'Beta', [amount(2)])];

  it('keeps a ranking that still holds and drops one whose extreme changed, whose value is gone or is masked now', () => {
    expect(again(SAID, reading(base)).kept).toHaveLength(1);
    expect(again(SAID, reading([node('W-1', 'Alpha', [amount(1)]), node('W-2', 'Beta', [amount(2)])])).kept).toHaveLength(0);
    expect(again(SAID, reading([node('W-1', 'Alpha', [amount(10)]), node('W-2', 'Beta', [])])).kept).toHaveLength(0);
    expect(again(SAID, reading([node('W-1', 'Alpha', [amount(10)]), node('W-2', 'Beta', [amount('***', { masked: true })])])).kept).toHaveLength(0);
  });

  it('keeps no sentence of an unmasked draft for a reading that masks a property, as before', () => {
    const current = reading([node('W-1', 'Alpha', [amount(10)]), node('W-2', 'Beta', [amount(2, { masked: true })])]);
    expect(rejudge({ sentences: [sentence(SAID)], inputRefs: inputs, mask: false } as never, current).kept).toHaveLength(0);
  });
});

describe('the check as a worker thread runs it', () => {
  it('gives the result in place when the checked text holds the values of a ranking', async () => {
    const text = checkedTextOf(assembleText(reading([node('W-1', 'Alpha', [amount(10)]), node('W-2', 'Beta', [amount(2)])])));
    const input: JudgeInput = { sentences: [{ text: 'Alpha has the largest amountDue, 10.', cites: ['n1', 'n2'] }, { text: 'Beta has the largest amountDue, 2.', cites: ['n1', 'n2'] }], text };
    let now = 0;
    const runner = createCheckRunner({ thresholdMs: 1, clock: () => now });
    const check = { name: 'ranking-judge', inline: (value: JudgeInput) => ((now += 100), judgeSentences(value.sentences, value.text)), module: JUDGE_MODULE, parse: parseJudged };
    const inPlace = await runner.run(check, input, { timeoutMs: 10_000 });
    const inWorker = await runner.run(check, input, { timeoutMs: 10_000 });
    expect(inPlace).toMatchObject({ status: 'done', value: { removed: 1 } });
    expect(inWorker).toEqual(inPlace);
  });
});
